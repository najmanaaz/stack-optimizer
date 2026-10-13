import { Aws, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

// Allows invoking a Bedrock model through a geographic (e.g. "eu.") cross-region
// inference profile. The underlying foundation model may run in any region of
// that geography, but only when the call comes through this profile.
export function grantInferenceProfile(grantee: iam.IGrantable, stack: Stack, profileId: string) {
  const profileArn = `arn:${Aws.PARTITION}:bedrock:${stack.region}:${stack.account}:inference-profile/${profileId}`;
  const foundationModelId = profileId.replace(/^[a-z]{2,4}\./, "");
  const actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({ actions, resources: [profileArn] }));
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions,
      resources: [`arn:${Aws.PARTITION}:bedrock:*::foundation-model/${foundationModelId}*`],
      conditions: { StringEquals: { "bedrock:InferenceProfileArn": profileArn } },
    })
  );
}
