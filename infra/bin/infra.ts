#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { AuthStack } from "../lib/auth-stack";
import { DataStack } from "../lib/data-stack";
import { AgentStack } from "../lib/agent-stack";
import { OpsStack } from "../lib/ops-stack";
import { ApiStack } from "../lib/api-stack";
import { CertStack } from "../lib/cert-stack";
import { WebStack } from "../lib/web-stack";

const app = new App();
const config = loadConfig({ alertEmail: app.node.tryGetContext("alertEmail") });
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

const auth = new AuthStack(app, `${config.appName}-Auth`, { env, config });
const data = new DataStack(app, `${config.appName}-Data`, { env, config });
const agent = new AgentStack(app, `${config.appName}-Agent`, { env, config, knowledgeBase: data.knowledgeBase });
const api = new ApiStack(app, `${config.appName}-Api`, {
  env,
  config,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  uploadsBucket: data.uploadsBucket,
  reportsTable: data.reportsTable,
  knowledgeBase: data.knowledgeBase,
  dataSource: data.dataSource,
  runtime: agent.runtime,
});
// CloudFront certificates must live in us-east-1
const cert = new CertStack(app, `${config.appName}-Cert`, {
  env: { account: env.account, region: "us-east-1" },
  crossRegionReferences: true,
  config,
});
new WebStack(app, `${config.appName}-Web`, {
  env,
  crossRegionReferences: true,
  config,
  certificate: cert.certificate,
  apiUrl: api.api.apiEndpoint,
  loginUrl: auth.loginUrl,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
});
new OpsStack(app, `${config.appName}-Ops`, { env, config });

Tags.of(app).add("app", config.appName);
