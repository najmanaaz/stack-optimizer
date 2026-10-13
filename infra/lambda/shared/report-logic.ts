// Input validation and deterministic report arithmetic, ported from
// api/stack-optimizer.js so the AWS and Vercel deployments behave the same.
// The agent only estimates per-layer costs; every total is computed here.

export const LAYERS = [
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { conversationForBrief } = require("../../../lib/stack-optimizer/chat");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nameItemRefs } = require("../../../lib/stack-optimizer/item-refs");

const PRIORITY_KEYS = ["cost", "performance", "sovereignty", "lockin", "lowops"];
const MAX_COMPONENTS = 30;

export interface Component {
  layer: string;
  component: string;
  /** null = not given; the advisor estimates it */
  monthlyCost: number | null;
  details: string;
}

export interface ReportInput {
  company: string;
  industry: string;
  region: "EU" | "US" | "Global";
  currency: "EUR" | "USD";
  priorities: string[];
  horizonYears: number;
  /** People in the team today and expected in 12 months; null = not given */
  teamSize: number | null;
  teamSizeNextYear: number | null;
  notes: string;
  /** The chat with the Context Agent before the report, as plain lines */
  conversation: string;
  components: Component[];
  /** File names shown to the advisor; the files themselves are in the Knowledge Base. */
  documentNames: string[];
}

// Whole number of people, or null when not given
export function headcount(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== "" && Number.isInteger(n) && n > 0 && n <= 1000000 ? n : null;
}

export function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Upload keys look like users/<sub>/<uuid>/<file name>. */
export function fileNameFromKey(key: string): string {
  return key.split("/").slice(3).join("/") || "document";
}

export function parseReportInput(
  body: any,
  userId: string,
  maxDocuments: number
): { input: ReportInput; documentKeys: string[] } | { error: string } {
  const components: Component[] = (Array.isArray(body.components) ? body.components : [])
    .map((c: any) => ({
      layer: LAYERS.includes(c?.layer) ? c.layer : "Other",
      component: clean(c?.component, 200),
      monthlyCost: c?.monthlyCost != null && c?.monthlyCost !== "" ? Number(c.monthlyCost) : null,
      details: clean(c?.details, 500),
    }))
    .filter((c: Component) => c.component);

  if (!components.length) return { error: "Add at least one tool you pay for." };
  if (components.length > MAX_COMPONENTS) return { error: `Please list at most ${MAX_COMPONENTS} components.` };
  for (const c of components) {
    if (c.monthlyCost !== null && (!Number.isFinite(c.monthlyCost) || c.monthlyCost < 0 || c.monthlyCost > 10000000)) {
      return { error: `Enter a valid monthly cost for "${c.component}".` };
    }
  }

  const rawKeys: unknown[] = Array.isArray(body.documents) ? body.documents : [];
  if (rawKeys.length > maxDocuments) return { error: `Please attach at most ${maxDocuments} context files.` };
  const prefix = `users/${userId}/`;
  const documentKeys = [...new Set(rawKeys.filter((k): k is string => typeof k === "string"))];
  for (const key of documentKeys) {
    // Only the caller's own uploads, in the shape the uploads handler issues
    if (!key.startsWith(prefix) || key.includes("..") || key.endsWith(".metadata.json") || key.split("/").length < 4) {
      return { error: "One of the attached files is not available. Please upload it again." };
    }
  }

  const horizon = Number(body.horizonYears);
  return {
    documentKeys,
    input: {
      company: clean(body.company, 120),
      industry: clean(body.industry, 120),
      region: ["EU", "US", "Global"].includes(body.region) ? body.region : "EU",
      currency: body.currency === "USD" ? "USD" : "EUR",
      priorities: (Array.isArray(body.priorities) ? body.priorities : []).filter((p: unknown) =>
        PRIORITY_KEYS.includes(p as string)
      ),
      horizonYears: [1, 3, 5].includes(horizon) ? horizon : 3,
      teamSize: headcount(body.teamSize),
      teamSizeNextYear: headcount(body.teamSizeNextYear),
      notes: clean(body.notes, 1500),
      conversation: conversationForBrief(body.chat),
      components,
      documentNames: documentKeys.map(fileNameFromKey),
    },
  };
}

// Combine the advisor's per-layer estimates with the client's real costs and do
// the arithmetic deterministically.
export function buildResponse(report: any, input: ReportInput) {
  // "item [27]" means nothing to the reader: use the tool's name
  report = nameItemRefs(report, input.components.map((c) => c.component));
  const byIndex = new Map<number, any>((report.layers || []).map((l: any) => [l.input_index, l]));
  const months = input.horizonYears * 12;

  const layers = input.components.map((c, i) => {
    const l = byIndex.get(i);
    // Costs the user left blank come from the advisor's estimate
    const estimated = c.monthlyCost === null;
    const current = estimated ? (l ? nonNegative(l.current_monthly_cost) : 0) : (c.monthlyCost as number);
    if (!l) {
      return {
        layer: c.layer,
        current_component: c.component,
        current_monthly_cost: current,
        current_cost_estimated: estimated,
        cloud_comparison: false,
        aws_services: "",
        aws_monthly_cost: current,
        gcp_services: "",
        gcp_monthly_cost: current,
        recommendation: "keep",
        alternative: "",
        rationale: "Not enough information to recommend a change.",
        migration_effort: "low",
        one_time_migration_cost: 0,
        efficiency_gains: "",
        recommended_monthly_cost: current,
      };
    }
    // Business software has no cloud equivalent: its cloud "options" are today's cost
    const cloud = l.cloud_comparison !== false;
    // A cloud with no suggested service (e.g. ruled out by the client's policies) is not an option
    const awsOption = cloud && !!clean(l.aws_services, 1000);
    const gcpOption = cloud && !!clean(l.gcp_services, 1000);
    const recommendation =
      (l.recommendation === "aws" && !awsOption) || (l.recommendation === "gcp" && !gcpOption) ? "keep" : l.recommendation;
    const aws = awsOption ? nonNegative(l.aws_monthly_cost) : current;
    const gcp = gcpOption ? nonNegative(l.gcp_monthly_cost) : current;
    const alternativeCost = recommendation === "cancel" ? 0 : Math.min(nonNegative(l.alternative_monthly_cost), current);
    const recommended =
      recommendation === "aws" ? aws
      : recommendation === "gcp" ? gcp
      : recommendation === "keep" ? current
      : alternativeCost;
    return {
      layer: c.layer,
      current_component: c.component,
      current_monthly_cost: current,
      current_cost_estimated: estimated,
      cloud_comparison: cloud,
      aws_services: awsOption ? l.aws_services : "",
      aws_monthly_cost: aws,
      gcp_services: gcpOption ? l.gcp_services : "",
      gcp_monthly_cost: gcp,
      recommendation,
      alternative: ["downgrade", "consolidate", "switch"].includes(recommendation) ? l.alternative || "" : "",
      rationale: l.rationale,
      migration_effort: l.migration_effort,
      one_time_migration_cost: recommendation === "keep" ? 0 : nonNegative(l.one_time_migration_cost),
      efficiency_gains: l.efficiency_gains,
      recommended_monthly_cost: recommended,
    };
  });

  const sum = (key: keyof (typeof layers)[number]) => round(layers.reduce((s, l) => s + (l[key] as number), 0));
  const current = sum("current_monthly_cost");
  const recommended = sum("recommended_monthly_cost");
  const migration = sum("one_time_migration_cost");
  const monthlySavings = round(current - recommended);

  return {
    currency: input.currency,
    horizon_years: input.horizonYears,
    team_size: input.teamSize,
    team_size_next_year: input.teamSizeNextYear,
    documents_used: input.documentNames,
    totals: {
      estimated_costs: layers.filter((l) => l.current_cost_estimated).length,
      current_monthly: current,
      all_aws_monthly: sum("aws_monthly_cost"),
      all_gcp_monthly: sum("gcp_monthly_cost"),
      recommended_monthly: recommended,
      monthly_savings: monthlySavings,
      annual_savings: round(monthlySavings * 12),
      savings_percent: current > 0 ? round((monthlySavings / current) * 100) : 0,
      one_time_migration_cost: migration,
      horizon_net_savings: round(monthlySavings * months - migration),
      payback_months: monthlySavings > 0 ? Math.round((migration / monthlySavings) * 10) / 10 : null,
      current_per_person: input.teamSize ? round(current / input.teamSize) : null,
      recommended_per_person: input.teamSize ? round(recommended / input.teamSize) : null,
    },
    executive_summary: report.executive_summary,
    layers,
    long_term_efficiency: report.long_term_efficiency || [],
    context_alignment: report.context_alignment || [],
    risks: report.risks || [],
    roadmap: report.roadmap || [],
    assumptions: report.assumptions || [],
  };
}

function nonNegative(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? round(n) : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
