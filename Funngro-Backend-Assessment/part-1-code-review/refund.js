// Refund can happen only once: the status change is the lock.
// Assumes MongoDB collections/client are configured elsewhere.

async function refundOnce(withdrawalId, reason) {
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      const withdrawal = await Withdrawals.findOneAndUpdate(
        {
          _id: withdrawalId,
          status: { $in: ["PROCESSING", "SUBMITTED"] }
        },
        {
          $set: {
            status: "FAILED",
            reason
          }
        },
        {
          session,
          returnDocument: "after"
        }
      );

      if (!withdrawal) {
        return; // Already refunded or completed: do nothing.
      }

      const wallet = await Wallets.findOneAndUpdate(
        { userId: withdrawal.userId },
        {
          $inc: { balancePaise: withdrawal.amountPaise }
        },
        {
          session,
          returnDocument: "after"
        }
      );

      await Ledger.insertOne(
        {
          userId: withdrawal.userId,
          type: "WITHDRAWAL_REVERSAL",
          amountPaise: withdrawal.amountPaise,
          balanceAfterPaise: wallet.balancePaise,
          withdrawalId: withdrawal._id,
          createdAt: new Date()
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
}
