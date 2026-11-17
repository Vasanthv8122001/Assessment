// POST /api/wallet/withdraw
// Header: Idempotency-Key
// Body: { amountPaise }
//
// Required indexes:
// Wallets:     { userId: 1 } unique
// Withdrawals: { userId: 1, idempotencyKey: 1 } unique
// Withdrawals: { status: 1, createdAt: 1 }
// Ledger:      { userId: 1, createdAt: -1 }
// Ledger:      { withdrawalId: 1, type: 1 } unique, partial (withdrawalId exists)
//
// Assumes MongoDB collections/client and gateway are configured elsewhere.

async function withdraw(req, res) {
  const userId = req.user.id; // from authentication, not request body
  const key = req.get("Idempotency-Key");
  const { amountPaise } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Idempotency-Key required" });
  }

  if (
    !Number.isSafeInteger(amountPaise) ||
    amountPaise < 10000 ||
    amountPaise > 1000000
  ) {
    return res.status(400).json({ error: "invalid amount" }); // ₹100–₹10,000
  }

  // Retry? Return the saved result.
  const existing = await Withdrawals.findOne({
    userId,
    idempotencyKey: key
  });

  if (existing) {
    return res.json(existing);
  }

  const user = await Users.findOne({ _id: userId });

  if (!user || !user.bankVerified) {
    return res.status(400).json({
      error: "verified bank account required"
    });
  }

  // Step 1: record + debit + ledger, all or nothing.
  const session = client.startSession();
  let withdrawal;

  try {
    await session.withTransaction(async () => {
      withdrawal = {
        _id: new ObjectId(),
        userId,
        idempotencyKey: key,
        amountPaise,
        bankAccount: user.bankAccount,
        status: "PROCESSING",
        createdAt: new Date()
      };

      await Withdrawals.insertOne(withdrawal, { session });

      const wallet = await Wallets.findOneAndUpdate(
        {
          userId,
          balancePaise: { $gte: amountPaise }
        },
        {
          $inc: { balancePaise: -amountPaise }
        },
        {
          session,
          returnDocument: "after"
        }
      );

      if (!wallet) {
        throw new Error("INSUFFICIENT");
      }

      await Ledger.insertOne(
        {
          userId,
          type: "WITHDRAWAL_DEBIT",
          amountPaise: -amountPaise,
          balanceAfterPaise: wallet.balancePaise,
          withdrawalId: withdrawal._id,
          createdAt: new Date()
        },
        { session }
      );
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT") {
      return res.status(400).json({ error: "insufficient balance" });
    }

    if (e.code === 11000) {
      // A parallel retry with the same key won.
      return res.json(
        await Withdrawals.findOne({ userId, idempotencyKey: key })
      );
    }

    throw e;
  } finally {
    await session.endSession();
  }

  // Step 2: send money only after it is recorded.
  // In production this should be dispatched through a queue + worker.
  try {
    const payout = await gateway.createPayout(
      {
        account: withdrawal.bankAccount,
        amountPaise,
        reference: String(withdrawal._id)
      },
      {
        idempotencyKey: String(withdrawal._id),
        timeoutMs: 10000
      }
    );

    await Withdrawals.updateOne(
      { _id: withdrawal._id, status: "PROCESSING" },
      {
        $set: {
          status: "SUBMITTED",
          gatewayId: payout.id
        }
      }
    );

    return res.status(202).json({
      withdrawalId: withdrawal._id,
      status: "SUBMITTED"
    });
  } catch (err) {
    const definiteReject =
      err.status >= 400 &&
      err.status < 500 &&
      ![408, 409, 429].includes(err.status);

    if (definiteReject) {
      await refundOnce(withdrawal._id, "gateway_rejected");

      return res.status(400).json({
        error: "payout rejected, amount refunded"
      });
    }

    // Timeout / 5xx: outcome is unknown. Do not refund yet.
    // A reconciler checks the gateway later.
    return res.status(202).json({
      withdrawalId: withdrawal._id,
      status: "PROCESSING"
    });
  }
}
