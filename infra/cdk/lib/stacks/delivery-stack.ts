import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as sns from "aws-cdk-lib/aws-sns"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs"
import * as lambda from "aws-cdk-lib/aws-lambda"
import type { Construct } from "constructs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../..")
const BUN_LOCK_FILE = path.join(REPO_ROOT, "bun.lock")

export interface DeliveryStackProps extends StackProps {
  /**
   * "Name <address>" sender for job-completion emails, sent via Resend.
   * The address must be on a domain verified in the Resend account.
   */
  notificationSender: string
}

/**
 * ARD §2.7 (Delivery): job-complete EventBridge bus, SNS internal fanout,
 * direct webhook POSTs, and email notifications for long-running jobs.
 *
 * Email goes through Resend, not SES: SES in this account is in sandbox
 * with no verified identity, while the Resend account already has a
 * verified sending domain. The API key lives in ResendApiKeySecret,
 * created empty here and populated once out-of-band:
 *   aws secretsmanager put-secret-value --secret-id <ResendApiKeySecretArn> \
 *     --secret-string <resend api key>
 */
export class DeliveryStack extends Stack {
  public readonly jobCompleteBus: events.EventBus
  public readonly webhookTopic: sns.Topic

  constructor(scope: Construct, id: string, props: DeliveryStackProps) {
    super(scope, id, props)

    // --- EventBridge: job-complete bus (ARD §2.7) ---
    this.jobCompleteBus = new events.EventBus(this, "JobCompleteBus", {
      eventBusName: "scrapeforge-job-complete",
    })

    // --- SNS: webhook fanout (ARD §2.7) ---
    this.webhookTopic = new sns.Topic(this, "WebhookTopic", {
      displayName: "ScrapeForge webhook fanout",
    })

    const resendApiKeySecret = new secretsmanager.Secret(
      this,
      "ResendApiKeySecret",
      {
        description:
          "Resend API key for job-completion email - populate manually, see class doc comment",
      }
    )

    // --- Lambda: consumes the bus, fans out to SNS, webhooks, email ---
    const notifyFn = new lambdaNode.NodejsFunction(this, "NotifyFn", {
      entry: path.join(REPO_ROOT, "services/delivery/src/notify.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: {
        WEBHOOK_TOPIC_ARN: this.webhookTopic.topicArn,
        NOTIFICATION_SENDER: props.notificationSender,
        RESEND_API_KEY_SECRET_ARN: resendApiKeySecret.secretArn,
      },
      bundling: {},
      depsLockFilePath: BUN_LOCK_FILE,
      projectRoot: REPO_ROOT,
    })
    this.webhookTopic.grantPublish(notifyFn)
    resendApiKeySecret.grantRead(notifyFn)

    new events.Rule(this, "JobCompleteRule", {
      eventBus: this.jobCompleteBus,
      eventPattern: { source: ["scrapeforge"], detailType: ["JobComplete"] },
      targets: [new targets.LambdaFunction(notifyFn)],
    })

    new CfnOutput(this, "JobCompleteBusName", {
      value: this.jobCompleteBus.eventBusName,
    })
    new CfnOutput(this, "ResendApiKeySecretArn", {
      value: resendApiKeySecret.secretArn,
    })
    new CfnOutput(this, "WebhookTopicArn", {
      value: this.webhookTopic.topicArn,
    })
  }
}
