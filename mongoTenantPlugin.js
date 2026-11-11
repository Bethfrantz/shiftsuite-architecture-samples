/**
 * Multi-tenant Mongoose plugin.
 *
 * Automatically:
 * - Adds tenantId to schemas
 * - Applies tenant filtering to queries
 * - Filters aggregation pipelines
 * - Attaches tenantId to new documents
 *
 * This prevents accidental cross-tenant
 * data access by enforcing isolation at
 * the model layer rather than individual routes.
 */

const mongoose = require("mongoose");
const { getTenantId } = require("./tenantContext");

module.exports = function multiTenantPlugin(schema) {
  // 1. Add tenantId field definition to every schema automatically
  if (!schema.paths.tenantId) {
    schema.add({
      tenantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Tenant",
        required: true,
        index: true, // Crucial for performance in multi-tenant DBs
      },
    });
  }
  // Define a chainable query helper method
  schema.query.bypassTenant = function () {
    return this.setOptions({ bypassTenant: true });
  };

  // Applying middleware here guarantees tenant isolation
  const QUERY_HOOKS = [
    "find",
    "findOne",
    "findById",
    "findOneAndUpdate",
    "findByIdAndUpdate",
    "findOneAndDelete",
    "findByIdAndDelete",
    "countDocuments",
    "distinct",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
  ];

  // 2. Intercept queries and apply the tenant filter
  QUERY_HOOKS.forEach((hook) => {
    schema.pre(hook, function (next) {
      // FIX: Check if the developer explicitly called .bypassTenant()
      if (this.getOptions().bypassTenant === true) {
        return next();
      }

      const tenantId = getTenantId();
      if (tenantId) {
        this.where({ tenantId });
      }
      next();
    });
  });

  schema.pre("aggregate", function (next) {
    const tenantId = getTenantId();
    // Used by system-level administrative operations
    if (!tenantId) {
      return next();
    }

    this.pipeline().unshift({
      $match: {
        tenantId,
      },
    });

    next();
  });

  // Intercept document creation/saving
  schema.pre("validate", function (next) {
    // If the doc already has a tenantId manually specified, don't overwrite it
    if (this.tenantId) {
      return next();
    }

    const tenantId = getTenantId();
    if (tenantId) {
      this.tenantId = tenantId;
    }
    next();
  });
};
