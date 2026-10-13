import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { StackOptimizerConfig } from "./config";

export interface CertStackProps extends StackProps {
  readonly config: StackOptimizerConfig;
}

// HTTPS certificate for the app's custom domain. CloudFront only accepts
// certificates from us-east-1, so this is the one stack outside eu-central-1;
// it holds no data. The domain's DNS is at GoDaddy, so validation is manual:
// while this stack deploys, add the CNAME that ACM shows (see infra/README.md).
export class CertStack extends Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, "AppCertificate", {
      domainName: props.config.appDomain,
      validation: acm.CertificateValidation.fromDns(),
    });
    new CfnOutput(this, "CertificateArn", { value: this.certificate.certificateArn });
  }
}
