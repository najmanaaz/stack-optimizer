// Central configuration for the Stack Optimizer on AWS.
// Everything environment-specific lives here; stacks read from this object only.

export interface StackOptimizerConfig {
  /** Prefix for stack and resource names. */
  readonly appName: string;
  /** All resources are deployed to one EU region for data residency. */
  readonly region: string;
  /** Public URL of the signed-in app (CloudFront custom domain). */
  readonly appUrl: string;
  /** Host name of appUrl, e.g. stack.t4tangerine.com (DNS at GoDaddy). */
  readonly appDomain: string;
  /** Extra origins allowed to call the API and sign in (local development). */
  readonly devOrigins: string[];
  /** Prefix for the Cognito managed login domain: <prefix>.auth.<region>.amazoncognito.com */
  readonly cognitoDomainPrefix: string;
  readonly models: {
    /** Stack Advisor (orchestrator). An EU cross-region inference profile keeps inference in the EU. */
    readonly advisor: string;
    /** Context Agent (RAG answers over the user's documents). */
    readonly context: string;
    /** Embedding model for the Knowledge Base. */
    readonly embedding: string;
    readonly embeddingDimensions: number;
  };
  /** How long uploaded context files are kept before automatic deletion. */
  readonly uploadRetentionDays: number;
  /** How long finished reports are kept. */
  readonly reportRetentionDays: number;
  /** AgentCore Memory short-term event retention (7-365 days). */
  readonly memoryRetentionDays: number;
  readonly limits: {
    /** Reports a user can start per rolling 24 hours (each report is several Opus calls). */
    readonly reportsPerUserPerDay: number;
    /** Context files per report. */
    readonly documentsPerReport: number;
    /** Largest context file a user can upload, in bytes. */
    readonly maxUploadBytes: number;
  };
  readonly budget: {
    /** Monthly spend in USD that triggers alerts at 80% (forecast) and 100% (actual). */
    readonly monthlyLimitUsd: number;
    /** Where budget alerts go. Set with: cdk deploy -c alertEmail=you@example.com */
    readonly alertEmail?: string;
  };
}

export function loadConfig(context: { alertEmail?: string }): StackOptimizerConfig {
  return {
    appName: "StackOptimizer",
    region: "eu-central-1",
    appUrl: "https://stack.t4tangerine.com",
    appDomain: "stack.t4tangerine.com",
    devOrigins: ["http://localhost:5173"],
    cognitoDomainPrefix: "t4tangerine-stack-optimizer",
    models: {
      // Verify these IDs before deploying:
      //   aws bedrock list-inference-profiles --region eu-central-1 --query "inferenceProfileSummaries[].inferenceProfileId"
      // and request Anthropic model access in the Bedrock console (once per account).
      // Claude 5.x is not yet enabled for this account (agreement NOT_AVAILABLE);
      // switch back to eu.anthropic.claude-opus-5-5 / eu.anthropic.claude-haiku-5-5 once AWS enables it.
      advisor: "eu.anthropic.claude-opus-4-6-v1",
      context: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      embedding: "amazon.titan-embed-text-v2:0",
      embeddingDimensions: 1024,
    },
    uploadRetentionDays: 30,
    reportRetentionDays: 365,
    memoryRetentionDays: 90,
    limits: {
      reportsPerUserPerDay: 10,
      documentsPerReport: 10,
      maxUploadBytes: 20 * 1024 * 1024,
    },
    budget: {
      monthlyLimitUsd: 100,
      alertEmail: context.alertEmail,
    },
  };
}
