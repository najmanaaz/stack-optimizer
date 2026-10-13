// Stack layers and client priorities shared by the Stack Optimizer endpoints
// (api/stack-optimizer.js, api/stack-autofill.js). The /stack page keeps the
// same layer names in its form.

const LAYERS = [
  "Frontend & Hosting",
  "Compute & Backend",
  "Containers & Orchestration",
  "Serverless & Functions",
  "Relational Database",
  "NoSQL Database",
  "Cache",
  "Object Storage",
  "CDN & Networking",
  "Authentication",
  "Messaging & Events",
  "Data & Analytics",
  "AI & ML",
  "Observability",
  "CI/CD",
  "Other",
];

const PRIORITIES = {
  cost: "Lowest total cost",
  performance: "Performance and scalability",
  sovereignty: "EU data residency and sovereignty",
  lockin: "Avoid vendor lock-in / portability",
  lowops: "Fully managed, low operational overhead",
};

module.exports = { LAYERS, PRIORITIES };
