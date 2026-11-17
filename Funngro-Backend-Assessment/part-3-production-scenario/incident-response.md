# Part 3 – Production Incident: First 30 Minutes

## Minute 0–5: declare and look

- Open an incident channel and tag the lead and support.
- Post: "Investigating. Next update in 15 min."
- Tell support: "Say the money is safe and recorded. No manual refunds."

Open the dashboards:

- **Application:** withdraw p95, error rate, number of gateway error logs.
- **MongoDB Atlas:** CPU, Query Targeting (documents scanned vs. returned), connections, disk IOPS, Profiler slow queries.
- **Gateway:** success rate, error codes (429, 5xx, timeouts), status page.

## Minute 5–10: check likely causes

### Is the database slow?

```javascript
db.currentOp({ active: true, secs_running: { $gte: 2 } });
db.Ledger.getIndexes();

db.Ledger.find({ userId: X })
  .sort({ createdAt: -1 })
  .explain("executionStats");
```

If you see `COLLSCAN` with about 40M documents examined, the missing index is a likely cause.

### Is the gateway failing?

```bash
grep "gateway error" app.log | awk '{print substr($2,1,5)}' | sort | uniq -c

grep "gateway error" app.log \
  | grep -oE "429|5[0-9]{2}|ETIMEDOUT" \
  | sort | uniq -c
```

Each gateway error needs investigation: depending on the gateway response, the payout may have failed or its outcome may be unknown.

### Any double debits?

Run on a secondary. This filters by `_id` time, so it can use the `_id` index instead of scanning all 40M documents.

```javascript
const since = ObjectId.createFromTime(
  Math.floor(Date.now() / 1000) - 3600
);

db.Ledger.aggregate([
  {
    $match: {
      _id: { $gte: since },
      type: "withdrawal"
    }
  },
  {
    $group: {
      _id: "$userId",
      n: { $sum: 1 }
    }
  },
  {
    $match: {
      n: { $gt: 1 }
    }
  }
]);
```

## Minute 10–15: stop the bleeding before root cause is known

- If there are gateway errors or double debits, pause withdrawals.
- Use a feature flag, or a quick hotfix that returns `503 "Withdrawals paused, your money is safe"`.
- Get a quick OK from the lead, but don't wait long. Every request that runs now can lose money, and pausing also removes load.

If the database is the cause:

- Hotfix to remove the history query from withdraw.
- Build `Ledger { userId: 1, createdAt: -1 }` and `Wallets { userId: 1 }` with an Atlas rolling build once load drops.
- Kill only long-running read scans.
- If CPU stays at 100%, scale up the Atlas tier.

If the gateway is the cause:

- Check its status page, raise a P1 ticket, and ask for its payout list for the last two hours.
- If it is a 429 rate limit, ask for a higher limit and resume slowly.

## Minute 15–25: find who was affected

- Compare our withdrawals with the gateway's payout list for the same time window.
- The reference was never saved, so match by bank account, amount and time.
- Put each user in one group: paid, failed (safe to refund), still processing (wait), double-debited, or unclear (manual review).
- Save the list to a separate collection.

## Minute 25–30: communicate and plan

- Update Slack: what we know, that withdrawals are paused, and the number of users and ₹ affected.
- Give support a script and the affected-user list.
- Next steps: deploy the fix, resume slowly while watching p95, then refund only the "failed" group with one reviewed script.

## What I would NOT do

| Action | Why |
|---|---|
| Bulk-refund complainers | Some payouts are only delayed and will still arrive, so those users would be paid twice. |
| Retry failed payouts in bulk | With no idempotency key, the gateway can't deduplicate, so it could pay twice. |
| Restart or roll back blindly | Restarts cut requests off between debit and ledger write, which creates more broken records. |
| Build a big index on the primary at peak, or run heavy queries on the primary | This slows the database down even more. |
| Edit or delete ledger records by hand | This destroys the audit trail. Fix things only with new ledger entries. |
| Go quiet | Support and the founder need updates every 15 minutes. |
