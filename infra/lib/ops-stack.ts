import { Stack, StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import { Construct } from "constructs";
import { StackOptimizerConfig } from "./config";

export interface OpsStackProps extends StackProps {
  readonly config: StackOptimizerConfig;
}

// Cost guardrail: a monthly budget on everything tagged app=<appName>, emailing
// at 80% of forecast and 100% of actual spend. Activate the "app" cost
// allocation tag in Billing > Cost allocation tags so the filter matches.
export class OpsStack extends Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);
    const { config } = props;
    const email = config.budget.alertEmail;

    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `${config.appName}Monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.budget.monthlyLimitUsd, unit: "USD" },
        costFilters: { TagKeyValue: [`user:app$${config.appName}`] },
      },
      notificationsWithSubscribers: email
        ? [
            {
              notification: {
                notificationType: "FORECASTED",
                comparisonOperator: "GREATER_THAN",
                threshold: 80,
                thresholdType: "PERCENTAGE",
              },
              subscribers: [{ subscriptionType: "EMAIL", address: email }],
            },
            {
              notification: {
                notificationType: "ACTUAL",
                comparisonOperator: "GREATER_THAN",
                threshold: 100,
                thresholdType: "PERCENTAGE",
              },
              subscribers: [{ subscriptionType: "EMAIL", address: email }],
            },
          ]
        : undefined,
    });
  }
}
