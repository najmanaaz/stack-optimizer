import * as fs from "fs";
import * as path from "path";
import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { grantInferenceProfile } from "./bedrock-access";
import { StackOptimizerConfig } from "./config";

export interface AgentStackProps extends StackProps {
  readonly config: StackOptimizerConfig;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
}

// Built by agents/build.sh (Linux ARM64 wheels + agent sources).
const AGENT_PACKAGE_DIR = path.join(__dirname, "..", "..", "agents", "dist");

// AgentCore resources for the Stack Advisor and Context Agent.
//
// Runtime: one Python (Strands) package hosting both agents. The Stack Advisor
// orchestrates and calls the Context Agent as a tool; the Context Agent queries
// the Knowledge Base filtered to the caller's user_id. IAM auth only: the
// report worker Lambda is the sole caller, users never reach the runtime.
//
// Memory gives the advisor persistent, per-user recall across reports
// (actorId = Cognito sub): preferences such as "EU-only" or "prefers managed
// services" and facts about the user's stack carry into the next report.
// Namespaces start with the actor so each user's recall is an exact-namespace
// lookup that can't reach another user's records.
export class AgentStack extends Stack {
  readonly memory: agentcore.Memory;
  readonly runtime: agentcore.Runtime;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { config, knowledgeBase } = props;

    this.memory = new agentcore.Memory(this, "AdvisorMemory", {
      memoryName: `${config.appName}AdvisorMemory`,
      description: "Per-user preferences and stack facts for the Stack Optimizer advisor",
      expirationDuration: Duration.days(config.memoryRetentionDays),
      memoryStrategies: [
        // Namespaces must match agents/src/memory.py
        agentcore.MemoryStrategy.usingUserPreference({
          strategyName: "user_preferences",
          description: "Client preferences: regions, vendors, managed vs self-run, priorities",
          namespaces: ["/actors/{actorId}/preferences"],
        }),
        agentcore.MemoryStrategy.usingSemantic({
          strategyName: "stack_facts",
          description: "Facts about the client's stack, constraints and earlier recommendations",
          namespaces: ["/actors/{actorId}/facts"],
        }),
      ],
    });

    if (!fs.existsSync(path.join(AGENT_PACKAGE_DIR, "main.py"))) {
      throw new Error("Agent package not built. Run agents/build.sh before cdk synth/deploy.");
    }

    this.runtime = new agentcore.Runtime(this, "AdvisorRuntime", {
      runtimeName: `${config.appName}Advisor`,
      description: "Stack Advisor orchestrator with Context Agent (RAG) for the Stack Optimizer",
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: AGENT_PACKAGE_DIR,
        runtime: agentcore.AgentCoreRuntime.PYTHON_3_13,
        entrypoint: ["main.py"],
      }),
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      // Each report is its own session; release instances soon after it finishes.
      lifecycleConfiguration: { idleRuntimeSessionTimeout: Duration.minutes(5) },
      environmentVariables: {
        ADVISOR_MODEL_ID: config.models.advisor,
        CONTEXT_MODEL_ID: config.models.context,
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        MEMORY_ID: this.memory.memoryId,
      },
    });

    for (const modelId of [config.models.advisor, config.models.context]) {
      grantInferenceProfile(this.runtime, this, modelId);
    }
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["bedrock:Retrieve"], resources: [knowledgeBase.attrKnowledgeBaseArn] })
    );
    this.memory.grantRead(this.runtime.role);
    this.memory.grantWrite(this.runtime.role);

    new CfnOutput(this, "MemoryId", { value: this.memory.memoryId });
    new CfnOutput(this, "RuntimeArn", { value: this.runtime.agentRuntimeArn });
  }
}
