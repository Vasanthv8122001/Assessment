// Monthly finance report: per user, points earned, converted and expired.
// Example window: October 2026 in IST.

const start = new Date("2026-10-01T00:00:00+05:30");
const end = new Date("2026-11-01T00:00:00+05:30");

const pipeline = [
  {
    $match: {
      occurredAt: { $gte: start, $lt: end },
      type: { $in: ["EARN", "CONVERT", "EXPIRE"] }
    }
  },
  {
    $group: {
      _id: "$userId",
      cohort: { $first: "$cohort" },
      earned: {
        $sum: {
          $cond: [
            { $eq: ["$type", "EARN"] },
            "$points",
            0
          ]
        }
      },
      converted: {
        $sum: {
          $cond: [
            { $eq: ["$type", "CONVERT"] },
            { $abs: "$points" },
            0
          ]
        }
      },
      expired: {
        $sum: {
          $cond: [
            { $eq: ["$type", "EXPIRE"] },
            { $abs: "$points" },
            0
          ]
        }
      }
    }
  },
  {
    $project: {
      _id: 0,
      userId: "$_id",
      cohort: 1,
      earned: 1,
      converted: 1,
      expired: 1
    }
  },
  {
    $sort: {
      cohort: 1,
      userId: 1
    }
  }
];

db.point_transactions.aggregate(pipeline, {
  allowDiskUse: true,
  readPreference: "secondary"
});

// Optional second aggregation stage for per-cohort totals,
// applied after the per-user group/project stages:
const cohortTotalsStage = {
  $group: {
    _id: "$cohort",
    users: { $sum: 1 },
    earned: { $sum: "$earned" },
    converted: { $sum: "$converted" },
    expired: { $sum: "$expired" }
  }
};
