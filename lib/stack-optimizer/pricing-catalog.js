// Reference list prices for common AWS and GCP building blocks, used by the
// Stack Advisor to ground its estimates instead of recalling prices from memory.
//
// Figures are approximate on-demand USD list prices (US regions) compiled from
// public pricing pages. EU regions are typically 5-15% higher. Review this file
// pricing-catalog.json periodically and verify against the official calculators
// before quoting. The JSON is shared with the AWS agents (agents/), which package it.

const { note: CATALOG_NOTE, categories: CATALOG } = require("./pricing-catalog.json");

const CATEGORIES = Object.keys(CATALOG);

function lookupPricing(category) {
  const entry = CATALOG[category];
  if (!entry) {
    return { error: `Unknown category. Use one of: ${CATEGORIES.join(", ")}` };
  }
  return { category, note: CATALOG_NOTE, aws: entry.aws, gcp: entry.gcp };
}

module.exports = { CATEGORIES, lookupPricing };
