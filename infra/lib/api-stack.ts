import * as path from "path";
import { Aws, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { grantInferenceProfile } from "./bedrock-access";
import { StackOptimizerConfig } from "./config";

export interface ApiStackProps extends StackProps {
  readonly config: StackOptimizerConfig;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly uploadsBucket: s3.IBucket;
  readonly reportsTable: dynamodb.ITable;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;
  readonly runtime: agentcore.IBedrockAgentRuntime;
}

const LAMBDA_DIR = path.join(__dirname, "..", "lambda");

// HTTP API in front of the agents. Every route requires a Cognito access/ID
// token; handlers scope all data to the token's sub.
//
//   POST /uploads              presigned PUT for a context file (+ metadata sidecar)
//   POST /autofill             pre-fill the form from the files' text
//   POST /reports              start a report  -> worker -> AgentCore Runtime
//   GET  /reports[/{reportId}] list / poll the caller's reports
//   DELETE /reports/{reportId} delete a report and its uploaded files
//   POST /chat                 chat with the Context Agent before the report
//
// Uploads reach the Knowledge Base through EventBridge -> ingest Lambda.
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, uploadsBucket, reportsTable, knowledgeBase, dataSource, runtime } = props;
    const knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

    const fn = (name: string, entry: string, extra: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(LAMBDA_DIR, entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(15),
        // Bundle the SDK: the Lambda-provided one can lag behind new services (AgentCore)
        bundling: { minify: true, sourceMap: true, externalModules: [] },
        environment: { NODE_OPTIONS: "--enable-source-maps" },
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH }),
        ...extra,
      });

    // ── Report worker: calls the agents ──
    const worker = fn("ReportWorker", "worker.ts", {
      timeout: Duration.minutes(15),
      retryAttempts: 0,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        REPORTS_TABLE: reportsTable.tableName,
        UPLOADS_BUCKET: uploadsBucket.bucketName,
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: dataSource.attrDataSourceId,
        AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
      },
    });
    reportsTable.grantReadWriteData(worker);
    runtime.grantInvokeRuntime(worker);
    worker.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["bedrock:GetKnowledgeBaseDocuments"], resources: [knowledgeBaseArn] })
    );

    // ── API handlers ──
    const reports = fn("ReportsHandler", "reports.ts", {
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        REPORTS_TABLE: reportsTable.tableName,
        WORKER_FUNCTION: worker.functionName,
        REPORT_RETENTION_DAYS: String(config.reportRetentionDays),
        REPORTS_PER_USER_PER_DAY: String(config.limits.reportsPerUserPerDay),
        DOCUMENTS_PER_REPORT: String(config.limits.documentsPerReport),
        UPLOADS_BUCKET: uploadsBucket.bucketName,
      },
    });
    reportsTable.grantReadWriteData(reports);
    uploadsBucket.grantDelete(reports, "users/*");
    worker.grantInvoke(reports);

    const uploads = fn("UploadsHandler", "uploads.ts", {
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        UPLOADS_BUCKET: uploadsBucket.bucketName,
        MAX_UPLOAD_BYTES: String(config.limits.maxUploadBytes),
      },
    });
    // Sidecar write plus the identity behind presigned PUTs
    uploadsBucket.grantPut(uploads, "users/*");

    // Form pre-fill from the text of uploaded files (extracted in the browser)
    const autofill = fn("AutofillHandler", "autofill.ts", {
      memorySize: 512,
      timeout: Duration.seconds(29), // API Gateway HTTP API integration limit
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        AUTOFILL_MODEL_ID: config.models.context,
      },
    });
    grantInferenceProfile(autofill, this, config.models.context);

    // Chat with the Context Agent before the report
    const chat = fn("ChatHandler", "chat.ts", {
      memorySize: 512,
      timeout: Duration.seconds(29), // API Gateway HTTP API integration limit
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        CHAT_MODEL_ID: config.models.context,
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: dataSource.attrDataSourceId,
        UPLOADS_BUCKET: uploadsBucket.bucketName,
      },
    });
    grantInferenceProfile(chat, this, config.models.context);
    chat.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Retrieve", "bedrock:GetKnowledgeBaseDocuments"],
        resources: [knowledgeBaseArn],
      })
    );

    // ── Knowledge Base ingestion on upload / expiry ──
    const ingest = fn("IngestHandler", "ingest.ts", {
      timeout: Duration.seconds(30),
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: dataSource.attrDataSourceId,
      },
    });
    ingest.addToRolePolicy(
      new iam.PolicyStatement({
        // Direct ingestion also checks StartIngestionJob on the Knowledge Base
        actions: ["bedrock:IngestKnowledgeBaseDocuments", "bedrock:DeleteKnowledgeBaseDocuments", "bedrock:StartIngestionJob"],
        resources: [knowledgeBaseArn],
      })
    );
    new events.Rule(this, "UploadEvents", {
      description: "Sync Stack Optimizer context files into the Knowledge Base",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created", "Object Deleted"],
        detail: {
          bucket: { name: [uploadsBucket.bucketName] },
          object: { key: [{ prefix: "users/" }] },
        },
      },
      targets: [new targets.LambdaFunction(ingest, { retryAttempts: 4, maxEventAge: Duration.hours(1) })],
    });

    // ── HTTP API ──
    const authorizer = new HttpUserPoolAuthorizer("CognitoAuthorizer", props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    this.api = new apigw.HttpApi(this, "HttpApi", {
      apiName: `${config.appName}Api`,
      description: "Stack Optimizer API (Cognito-authenticated)",
      corsPreflight: {
        allowOrigins: [config.appUrl, ...config.devOrigins],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    const reportsIntegration = new HttpLambdaIntegration("ReportsIntegration", reports);
    this.api.addRoutes({ path: "/reports", methods: [apigw.HttpMethod.POST, apigw.HttpMethod.GET], integration: reportsIntegration });
    this.api.addRoutes({ path: "/reports/{reportId}", methods: [apigw.HttpMethod.GET, apigw.HttpMethod.DELETE], integration: reportsIntegration });
    this.api.addRoutes({
      path: "/chat",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("ChatIntegration", chat),
    });
    this.api.addRoutes({
      path: "/autofill",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("AutofillIntegration", autofill),
    });
    this.api.addRoutes({
      path: "/uploads",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("UploadsIntegration", uploads),
    });

    // Account-wide safety net on top of the per-user daily report limit
    const stage = this.api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
    new CfnOutput(this, "Region", { value: Aws.REGION });
  }
}
