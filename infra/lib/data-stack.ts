import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import { Construct } from "constructs";
import { StackOptimizerConfig } from "./config";

export interface DataStackProps extends StackProps {
  readonly config: StackOptimizerConfig;
}

// Storage for the Stack Optimizer:
// - Uploads bucket: users' context files (SOPs, playbooks, tenets, goals) under
//   users/<cognito-sub>/..., each with a .metadata.json sidecar holding user_id
//   so Knowledge Base retrieval can be filtered to the caller's own documents.
// - Knowledge Base on S3 Vectors: the RAG index the Context Agent queries.
// - Reports table: report jobs and results, keyed by user.
export class DataStack extends Stack {
  readonly uploadsBucket: s3.Bucket;
  readonly reportsTable: dynamodb.Table;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      // Upload and expiry events drive Knowledge Base ingestion (StackOptimizer-Api)
      eventBridgeEnabled: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [config.appUrl, ...config.devOrigins],
          allowedHeaders: ["content-type", "x-amz-*"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { id: "ExpireUploads", prefix: "users/", expiration: Duration.days(config.uploadRetentionDays) },
        { id: "AbortIncompleteUploads", abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.reportsTable = new dynamodb.Table(this, "ReportsTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "reportId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── Knowledge Base on S3 Vectors ──
    const vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
      encryptionConfiguration: { sseType: "AES256" },
    });

    const vectorIndex = new s3vectors.CfnIndex(this, "VectorIndex", {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: "context-docs",
      dataType: "float32",
      dimension: config.models.embeddingDimensions,
      distanceMetric: "cosine",
      // Bedrock stores chunk text and its own metadata here; keeping them
      // non-filterable leaves the filterable-metadata budget for user_id.
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"],
      },
    });

    const embeddingModelArn = `arn:${Aws.PARTITION}:bedrock:${this.region}::foundation-model/${config.models.embedding}`;

    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${Aws.PARTITION}:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    });
    kbRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: [embeddingModelArn] })
    );
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:QueryVectors",
          "s3vectors:GetIndex",
        ],
        resources: [vectorIndex.attrIndexArn],
      })
    );
    this.uploadsBucket.grantRead(kbRole, "users/*");
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [this.uploadsBucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["users/*"] } },
      })
    );

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${config.appName}ContextDocs`,
      description: "Users' uploaded SOPs, playbooks, tenets and goals for the Stack Optimizer Context Agent",
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: config.models.embeddingDimensions,
              embeddingDataType: "FLOAT32",
            },
          },
        },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: { indexArn: vectorIndex.attrIndexArn },
      },
    });
    // Bedrock validates the role's permissions at creation, so attach the policy first
    this.knowledgeBase.node.addDependency(kbRole.node.findChild("DefaultPolicy"));

    this.dataSource = new bedrock.CfnDataSource(this, "UploadsDataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: "user-uploads",
      dataDeletionPolicy: "DELETE",
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: this.uploadsBucket.bucketArn,
          inclusionPrefixes: ["users/"],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: { maxTokens: 400, overlapPercentage: 15 },
        },
      },
    });

    new CfnOutput(this, "UploadsBucketName", { value: this.uploadsBucket.bucketName });
    new CfnOutput(this, "ReportsTableName", { value: this.reportsTable.tableName });
    new CfnOutput(this, "KnowledgeBaseId", { value: this.knowledgeBase.attrKnowledgeBaseId });
    new CfnOutput(this, "DataSourceId", { value: this.dataSource.attrDataSourceId });
  }
}
