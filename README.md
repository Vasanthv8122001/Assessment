# Funngro – Backend Engineering Assessment

**Role:** Backend Engineer (Node.js / MongoDB)

This submission is organized into Markdown answer files and JavaScript implementation files.

## Folder structure

```text
Funngro-Backend-Assessment/
├── README.md
├── part-1-code-review/
│   ├── review.md
│   ├── withdraw.js
│   └── refund.js
├── part-2-schema-design/
│   ├── schema.md
│   └── monthly-report.js
├── part-3-production-scenario/
│   └── incident-response.md
└── part-4-walkthrough/
    └── recording-notes.md
```

## Assumptions

- Money is stored as integer paise (₹1 = 100 paise), not decimal rupees.
- MongoDB is a replica set (Atlas), so transactions are available.
- The gateway supports an idempotency key and lookup by reference, and sends a webhook with the final result.
- Authentication middleware already exists and sets `req.user`.
- "Cohort" means the user's signup month (e.g. `2026-03`).
- Report months use IST.

## Questions I'd ask

1. Does the gateway support idempotency keys and "get payout by reference"?
2. Can we ship an app update that sends an `Idempotency-Key` header? How long do old app versions stay in use?
3. Users are minors. Are there legal or parental limits on withdrawals?
4. Is it OK for withdraw to return `"processing"` instead of `"done"`?
5. Do points expire on a fixed rule (e.g. 12 months), or per campaign?
6. Should the finance report include manual adjustments?

## Important

The JavaScript files contain the code from the proposed answer. Infrastructure-dependent parts, such as the queue worker, gateway webhook, and reconciliation worker, are described as pseudocode in the Markdown answers. The code should be reviewed against the actual gateway SDK and MongoDB driver version before execution.
# Assessment
