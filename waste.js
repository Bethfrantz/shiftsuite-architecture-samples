const express = require("express");
const router = express.Router();

const Store = require("../models/Store");
const Waste = require("../models/Waste");
const Category = require("../models/Category");
const FinishedProduct = require("../models/FinishedProduct");
const InventoryCount = require("../models/InventoryCount");

const { requireAuth } = require("../middleware/auth");

/**
 * Waste Management
 *
 * This module serves two purposes:
 *
 * 1. Record inventory waste and update inventory levels.
 * 2. Generate operational waste reports for management.
 *
 * Business Rules:
 *
 * - Waste can be recorded against raw inventory items.
 * - Waste can be recorded against finished products.
 * - Finished product waste automatically deducts ingredient inventory.
 * - Inventory is never allowed to become negative.
 * - Waste reporting includes quantity, cost, category, and reason analysis.
 */

const throwError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

/**
 * Validates inventory before a deduction occurs.
 *
 * Preventing negative inventory is critical because
 * negative values compromise inventory reporting,
 * reconciliation, and audit accuracy.
 */
async function validateInventoryDeduction({
  storeId,
  itemId,
  deductionAmount,
  itemName,
}) {
  const inventory = await InventoryCount.findOne({
    storeId,
    itemId,
  });

  if (!inventory) {
    throwError(`Inventory record not found for ${itemName}`, 404);
  }

  if (inventory.quantity - deductionAmount < 0) {
    throwError(`${itemName} would result in negative inventory`, 400);
  }

  return inventory;
}

/**
 * Deduct inventory after validation has passed.
 */
async function deductInventory({ storeId, itemId, amount }) {
  await InventoryCount.updateOne(
    {
      storeId,
      itemId,
    },
    {
      $inc: {
        quantity: -amount,
      },
    },
  );
}

/**
 * ----------------------------------------------------
 * Create Waste Record
 * POST /waste
 * ----------------------------------------------------
 */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { storeId, type, rawItemId, finishedProductId, quantity, reason } =
      req.body;

    if (!storeId || !type || !quantity) {
      throwError("storeId, type, and quantity are required");
    }

    if (quantity <= 0) {
      throwError("quantity must be greater than zero");
    }

    if (type === "raw" && !rawItemId) {
      throwError("rawItemId is required for raw waste");
    }

    if (type === "finished" && !finishedProductId) {
      throwError("finishedProductId is required for finished waste");
    }

    const store = await Store.findById(storeId);

    if (!store) {
      throwError("Store not found", 404);
    }

    const waste = await Waste.create({
      storeId,
      type,
      rawItemId,
      finishedProductId,
      quantity,
      reason,
    });

    /**
     * Raw inventory waste directly reduces
     * on-hand quantity.
     */
    if (type === "raw") {
      await validateInventoryDeduction({
        storeId,
        itemId: rawItemId,
        deductionAmount: quantity,
        itemName: "Raw Inventory Item",
      });

      await deductInventory({
        storeId,
        itemId: rawItemId,
        amount: quantity,
      });
    }

    /**
     * Finished product waste cascades down
     * to ingredient inventory.
     *
     * Example:
     * Wasting 2 pizzas also wastes the
     * ingredient quantities consumed by
     * those 2 pizzas.
     */
    if (type === "finished") {
      const finished = await FinishedProduct.findById(
        finishedProductId,
      ).populate({
        path: "ingredients.itemId",
        select: "name currentPrice photoUrl",
      });

      if (!finished) {
        throwError("Finished product not found", 404);
      }

      for (const ingredient of finished.ingredients) {
        const deduction = ingredient.quantityUsed * quantity;

        await validateInventoryDeduction({
          storeId,
          itemId: ingredient.itemId._id,
          deductionAmount: deduction,
          itemName: ingredient.itemId.name,
        });

        await deductInventory({
          storeId,
          itemId: ingredient.itemId._id,
          amount: deduction,
        });
      }
    }

    res.json({ waste });
  } catch (err) {
    next(err);
  }
});

/**
 * ----------------------------------------------------
 * Waste Report
 * GET /waste/report
 * ----------------------------------------------------
 */
router.get("/report", requireAuth, async (req, res, next) => {
  try {
    const { storeId, startDate, endDate } = req.query;

    if (!storeId) {
      throwError("storeId is required");
    }

    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const end = endDate ? new Date(endDate) : new Date();

    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    const wasteRecords = await Waste.find({
      storeId,
      timestamp: {
        $gte: start,
        $lte: end,
      },
    }).populate("rawItemId");

    if (!wasteRecords.length) {
      return res.json({
        storeId,
        startDate: start,
        endDate: end,
        items: [],
        categories: [],
        reasons: [],
        totals: {
          totalWasteQuantity: 0,
          totalWasteCost: 0,
        },
      });
    }

    /**
     * Aggregate waste by inventory item.
     */
    const itemMap = new Map();

    for (const record of wasteRecords) {
      const item = record.rawItemId;

      if (!item) continue;

      const id = item._id.toString();
      const price = item.currentPrice || 0;

      if (!itemMap.has(id)) {
        itemMap.set(id, {
          itemId: id,
          name: item.name,
          categoryId: item.categoryId,
          quantity: 0,
          cost: 0,
        });
      }

      const existing = itemMap.get(id);

      existing.quantity += record.quantity;
      existing.cost += record.quantity * price;
    }

    const items = Array.from(itemMap.values());

    /**
     * Aggregate waste by category.
     */
    const categoryIds = [
      ...new Set(items.map((i) => i.categoryId?.toString())),
    ];

    const categories = await Category.find({
      _id: {
        $in: categoryIds,
      },
    });

    const categoryLookup = new Map(
      categories.map((category) => [category._id.toString(), category.name]),
    );

    const categoryMap = new Map();

    for (const item of items) {
      const categoryId = item.categoryId?.toString();

      if (!categoryMap.has(categoryId)) {
        categoryMap.set(categoryId, {
          categoryId,
          categoryName: categoryLookup.get(categoryId) || "Unknown Category",
          quantity: 0,
          cost: 0,
        });
      }

      const entry = categoryMap.get(categoryId);

      entry.quantity += item.quantity;
      entry.cost += item.cost;
    }

    /**
     * Aggregate waste reasons.
     */
    const reasonMap = new Map();

    for (const record of wasteRecords) {
      const reason = record.reason || "Unspecified";

      if (!reasonMap.has(reason)) {
        reasonMap.set(reason, {
          reason,
          quantity: 0,
        });
      }

      reasonMap.get(reason).quantity += record.quantity;
    }

    const categoriesSummary = Array.from(categoryMap.values());

    const reasons = Array.from(reasonMap.values());

    const totalWasteQuantity = items.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    const totalWasteCost = items.reduce((sum, item) => sum + item.cost, 0);

    res.json({
      storeId,
      startDate: start,
      endDate: end,
      items,
      categories: categoriesSummary,
      reasons,
      totals: {
        totalWasteQuantity,
        totalWasteCost,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
