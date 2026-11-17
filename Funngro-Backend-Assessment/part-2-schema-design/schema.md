# Part 2 – Schema and Query Design

## 2.1 Collections

### `point_accounts`

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  balance: Number, // integer points
  updatedAt: Date
}
```

### `point_lots`

One document per earning event; needed to track expiry.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  source: {
    type: "PROJECT" | "PROMO",
    refId: ObjectId
  },
  points: Number,       // integer points originally earned
  remaining: Number,    // integer points not yet consumed
  earnedAt: Date,
  expiresAt: Date,
  status: "ACTIVE" | "USED" | "EXPIRED"
}
```

### `point_transactions`

Append-only ledger; never edit existing transaction rows.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  cohort: String, // e.g. "2026-03", copied in for reporting
  type: "EARN" | "CONVERT" | "EXPIRE" | "ADJUST",
  points: Number, // +earn, -convert, -expire
  balanceAfter: Number,
  lots: [
    {
      lotId: ObjectId,
      points: Number
    }
  ],
  sourceKey: String, // "PROJECT:<id>", "CONVERT:<id>", "EXPIRE:<lotId>"
  conversionId: ObjectId, // only for CONVERT
  cashPaise: Number,     // only for CONVERT
  occurredAt: Date
}
```

### `conversion_rates`

Insert-only history; do not edit historical rates.

```javascript
{
  _id: ObjectId,
  paisePerPointNum: Number, // rate as a fraction; no floats
  paisePerPointDen: Number,
  effectiveFrom: Date,
  createdBy: ObjectId,
  approvedBy: ObjectId
}
```

### `conversions`

Audit record for each conversion.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  idempotencyKey: String,
  points: Number,
  rateId: ObjectId,
  paisePerPointNum: Number, // snapshot of rate used
  paisePerPointDen: Number,
  cashPaise: Number,
  status: "COMPLETED" | "FAILED",
  pointTxnId: ObjectId,
  walletLedgerId: ObjectId,
  createdAt: Date
}
```

## Indexes and the queries they serve

| Index | Query it serves |
|---|---|
| `point_accounts { userId: 1 }` unique | Balance lookup and atomic debit during conversion |
| `point_transactions { userId: 1, occurredAt: -1 }` | User's points history screen |
| `point_transactions { occurredAt: 1 }` | Monthly report: reads only one month |
| `point_transactions { sourceKey: 1 }` unique | Same project, expiry or conversion is never booked twice |
| `point_lots { userId: 1, status: 1, expiresAt: 1 }` | Conversion consumes user's soonest-expiring active lots first |
| `point_lots { status: 1, expiresAt: 1 }` | Nightly job that expires old lots |
| `conversions { userId: 1, idempotencyKey: 1 }` unique | Retries don't convert twice |
| `conversion_rates { effectiveFrom: -1 }` | Get the current rate |

## 2.2 Monthly finance report

The aggregation pipeline is in [`monthly-report.js`](./monthly-report.js). It returns, per user, points earned, converted and expired in the requested month. It also includes the user's signup-month cohort.

The example report window is October 2026 in IST.
