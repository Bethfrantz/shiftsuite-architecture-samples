const express = require("express");
const router = express.Router();

const InventorySnapshot = require("../models/InventorySnapshot");
const InventoryCount = require("../models/InventoryCount");
const Usage = require("../models/Usage");
const Waste = require("../models/Waste");
const Item = require("../models/Item");

const { requireAuth } = require("../middleware/auth");

/**
 * Daily Inventory Snapshot Generator
 *
 * Creates an immutable point-in-time inventory record
 * used for:
 *
 * - Historical reporting
 * - Inventory auditing
 * - Cost analysis
 * - Inventory reconciliation
 *
 * A snapshot combines:
 *
 * - Latest inventory counts
 * - Product usage
 * - Product waste
 * - Current item costs
 *
 * The resulting snapshot represents inventory state
 * for a specific store and date.
 */

const throwError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

/**
 * Retrieve the most recent count recorded for each item
 * during the requested day.
 */
async function getLatestCounts(storeId, start, end) {
  return InventoryCount.aggregate([
    {
      $match: {
        storeId,
        timestamp: {
          $gte: start,
          $lte: end,
        },
      },
    },
    {
      $sort: {
        timestamp: -1,
      },
    },
    {
      $group: {
        _id: "$itemId",
        latestCount: {
          $first: "$countedQuantity",
        },
      },
    },
  ]);
}

/**
 * Aggregate item usage for the requested day.
 *
 * Usage is tracked separately from waste so operations
 * can distinguish between expected consumption and loss.
 */
async function getUsageTotals(storeId, start, end) {
  return Usage.aggregate([
    {
      $match: {
        storeId,
        timestamp: {
          $gte: start,
          $lte: end,
        },
      },
    },
    {
      $group: {
        _id: "$itemId",
        totalUsed: {
          $sum: "$quantityUsed",
        },
      },
    },
  ]);
}

/**
 * Aggregate waste recorded during the day.
 *
 * Waste impacts inventory differently than usage and
 * is tracked separately for operational reporting.
 */
async function getWasteTotals(storeId, start, end) {
  return Waste.aggregate([
    {
      $match: {
        storeId,
        timestamp: {
          $gte: start,
          $lte: end,
        },
      },
    },
    {
      $group: {
        _id: "$itemId",
        totalWaste: {
          $sum: "$quantity",
        },
      },
    },
  ]);
}

/**
 * Build efficient lookup maps.
 *
 * Maps provide constant-time access and avoid repeated
 * array scans while building large snapshots.
 */
function buildLookupMap(records) {
  return new Map(records.map((record) => [record._id.toString(), record]));
}

/**
 * Combine inventory counts, usage, waste, and item
 * pricing into a snapshot-friendly structure.
 */
function buildSnapshotItems({ items, countMap, usageMap, wasteMap }) {
  return items.map((item) => {
    const itemId = item._id.toString();

    const quantity = countMap.get(itemId)?.latestCount || 0;

    const usage = usageMap.get(itemId)?.totalUsed || 0;

    const waste = wasteMap.get(itemId)?.totalWaste || 0;

    return {
      itemId,
      name: item.name,
      quantity,
      usageSinceLast: usage,
      wasteSinceLast: waste,

      /**
       * Cost impact estimates how much inventory value
       * is currently represented by the counted amount.
       */
      costImpact: quantity * (item.currentPrice || 0),
    };
  });
}

/**
 * --------------------------------------------------
 * Daily Snapshot Generation
 * --------------------------------------------------
 *
 * GET /inventorySnapshots/daily
 * ?storeId=xxx
 * &date=YYYY-MM-DD
 *
 * Generates and persists a daily inventory snapshot.
 */
router.get("/daily", requireAuth, async (req, res, next) => {
  try {
    const { storeId, date } = req.query;

    if (!storeId || !date) {
      throwError("storeId and date are required", 400);
    }

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);

    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    /**
     * Gather source data.
     */
    const counts = await getLatestCounts(storeId, start, end);

    const usages = await getUsageTotals(storeId, start, end);

    const wastes = await getWasteTotals(storeId, start, end);

    /**
     * Build lookup maps to avoid O(n²)
     * searches while constructing output.
     */
    const countMap = buildLookupMap(counts);
    const usageMap = buildLookupMap(usages);
    const wasteMap = buildLookupMap(wastes);

    const itemIds = counts.map((count) => count._id);

    const items = await Item.find({
      _id: {
        $in: itemIds,
      },
    });

    const snapshotItems = buildSnapshotItems({
      items,
      countMap,
      usageMap,
      wasteMap,
    });

    /**
     * Snapshots are intentionally immutable.
     * Historical reporting should always reflect
     * inventory as it existed on the selected day.
     */
    const snapshot = await InventorySnapshot.create({
      storeId,
      timestamp: end,
      items: snapshotItems,
    });

    res.json({
      snapshot,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * --------------------------------------------------
 * Existing Snapshot CRUD Routes
 * --------------------------------------------------
 */

/**
 * Create Snapshot Manually
 */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const snapshot = await InventorySnapshot.create(req.body);

    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

/**
 * Get All Snapshots
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const snapshots = await InventorySnapshot.find()
      .populate("storeId")
      .populate("items.itemId");

    res.json(snapshots);
  } catch (err) {
    next(err);
  }
});

/**
 * Get Snapshots For Store
 */
router.get("/store/:storeId", requireAuth, async (req, res, next) => {
  try {
    const snapshots = await InventorySnapshot.find({
      storeId: req.params.storeId,
    }).populate("items.itemId");

    res.json(snapshots);
  } catch (err) {
    next(err);
  }
});

/**
 * Get Single Snapshot
 */
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const snapshot = await InventorySnapshot.findById(req.params.id)
      .populate("storeId")
      .populate("items.itemId");

    if (!snapshot) {
      throwError("Snapshot not found", 404);
    }

    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

/**
 * Delete Snapshot
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const deleted = await InventorySnapshot.findByIdAndDelete(req.params.id);

    if (!deleted) {
      throwError("Snapshot not found", 404);
    }

    res.json({
      message: "Snapshot deleted",
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
