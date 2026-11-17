# Part 1 – Code Review of the Payout Handler

## 1.1 Problems, most dangerous first

### 1. Two requests can withdraw the same money (race condition)

**What goes wrong:** The code reads the balance, checks it in JavaScript, then writes the new balance. Two requests at the same moment both see the old balance and both pass.

**Scenario:** The user has ₹1,000 and double-taps Withdraw. Both requests see ₹1,000, both pay ₹1,000, and we lose ₹1,000. A reward credited between the read and the write is also overwritten and lost.

**Fix:** Check and debit in one atomic step: `findOneAndUpdate({ userId, balance: { $gte: amount } }, { $inc: { balance: -amount } })`.

### 2. No idempotency, and the app retries on timeout

**What goes wrong:** The server can't tell a retry from a new request.

**Scenario:** Payout day, the server is slow, and the app times out and retries. The first request still finishes, so the user is paid twice. No attacker is needed.

**Fix:** The client sends an `Idempotency-Key`. Store it with a unique index on `(userId, idempotencyKey)`. A retry returns the first result.

### 3. Gateway errors are ignored, so money is debited but never sent

**What goes wrong:** `createPayout` isn't awaited, so `try/catch` never catches its asynchronous errors. Even if it did, it only logs them. The wallet stays debited, there's no refund, and the payout status is never saved.

**Scenario:** The gateway rate-limits us or the bank account is invalid. The user loses money in the app and gets nothing in the bank. These are the "debited but not received" complaints.

**Fix:** Await the call and save a status. If the gateway clearly rejected it, refund. If the result is unknown (timeout), don't refund; check with the gateway later.

### 4. No input validation: a negative amount creates money

**What goes wrong:** With `amount = -5000`, the check passes and `balance - (-5000)` adds ₹5,000. Strings, `NaN` and decimals also get through.

**Scenario:** A user edits the request, gets ₹5,000 added, then withdraws it for real.

**Fix:** Accept only a positive integer amount in paise, within min/max limits.

### 5. No authentication: `userId` comes from the request body

**What goes wrong:** Whoever sends the request picks whose wallet is debited.

**Scenario:** An attacker sends other users' IDs and triggers withdrawals from thousands of wallets.

**Fix:** Take the user from the login token (`req.user.id`).

### 6. No transaction across debit, payout record and ledger

**What goes wrong:** These are separate writes. A crash in between leaves them out of sync.

**Scenario:** The server crashes after the debit but before the ledger write. The money is gone and there's no record of why, so finance can't reconcile.

**Fix:** Write the withdrawal record, the debit and the ledger entry in one transaction. Call the gateway only after it commits.

### 7. The reference `'WD-' + Date.now()` is not unique and not saved

**What goes wrong:** It isn't guaranteed unique and changes on every retry.

**Scenario:** Two requests in the same millisecond get the same reference. A retry gets a new reference, so the gateway can't deduplicate. During an incident we can't match gateway records to ours.

**Fix:** Use our withdrawal `_id` as the reference and as the gateway's idempotency key, and save it.

### 8. Missing indexes and an unbounded history query

**What goes wrong:** Wallets (2M documents) and Ledger (40M documents) can require collection scans, and the code loads the user's entire history on every withdrawal.

**Scenario:** Slow responses cause app timeouts, timeouts cause retries, and retries cause double payouts (bugs 1 and 2).

**Fix:** Unique index `Wallets { userId: 1 }`; index `Ledger { userId: 1, createdAt: -1 }`. Remove history from this response and serve it from a paginated endpoint.

### 9. Null wallet crashes the handler

**Scenario:** A user with no wallet gets a `TypeError` and a 500, and the app keeps retrying.

**Fix:** Handle the missing wallet. The atomic update covers it, because it simply matches nothing.

### 10. No business checks

**What goes wrong:** No verified bank account check, KYC, daily limit, or frozen-account check. The users are minors, so legal limits probably apply.

**Fix:** Run these checks before debiting.

### 11. Floats for money, `console.log`, and a large response

**Fix:** Store integer paise, use structured logs with no bank details, and keep the response small.

### Why this order?

Bugs 1–3 lose money on their own, during normal use, on the busiest day. Bug 4 is just as bad per case, but someone has to try it on purpose. The rest are security, data-integrity and performance problems that make the money bugs worse.

## 1.2 Rewrite

The implementation is split between `withdraw.js` and `refund.js`.

The withdrawal record, debit and ledger entry are written in one MongoDB transaction. The gateway is called only after the transaction commits. A timeout or ambiguous gateway response leaves the withdrawal processing so that a reconciler can check its final state.

See:
- [`withdraw.js`](./withdraw.js)
- [`refund.js`](./refund.js)

### Indexes

```javascript
// Wallets
{ userId: 1 } // unique

// Withdrawals
{ userId: 1, idempotencyKey: 1 } // unique
{ status: 1, createdAt: 1 } // reconciler

// Ledger
{ userId: 1, createdAt: -1 }
{ withdrawalId: 1, type: 1 } // unique, partial (withdrawalId exists)
```

### Infrastructure pseudocode

- Verify the gateway webhook signature.
- On `processed`, update the withdrawal status to `COMPLETED`.
- On `failed`, call `refundOnce()`.
- Every five minutes, find `PROCESSING`/`SUBMITTED` withdrawals older than ten minutes and ask the gateway by reference:
  - `paid` → `COMPLETED`
  - `failed` → `refundOnce()`
  - `not found` → resend using the same idempotency key, if the gateway's contract makes that safe.

## 1.3 Overall design changes

I'd make the ledger the source of truth, with the wallet balance as a cached number that a nightly job checks against the ledger total. Payouts would go through a queue and workers with a clear status flow, so the API never waits on the gateway and a crash never leaves money in an unknown state. I'd run a daily reconciliation against the gateway's settlement report to catch any mismatch. I'd also add a kill switch to pause withdrawals instantly, per-user and global limits, and alerts on payout failures.
