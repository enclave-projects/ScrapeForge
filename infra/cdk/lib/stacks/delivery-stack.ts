import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as sns from "aws-cdk-lib/aws-sns"
import * as ses from "aws-cdk-lib/aws-ses"
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import type { Construct } from "constructs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../..")
const BUN_LOCK_FILE = path.join(REPO_ROOT, "bun.lock")

export interface DeliveryStackProps extends StackProps {
  /**
   * Sender address for job-completion emails. SES starts every new
   * account in sandbox mode (can only send to/from verified identities),
   * and this stack can only request verification, not complete it — an
   * email/link confirmation only the account owner can click. Until
   * that happens (and until SES production access is requested for this
   * account), SES sends here will fail. Not a bug, an external step.
   */
  notificationSenderEmail: string
}

/**
 * ARD §2.7 (Delivery): job-complete EventBridge bus, SNS webhook fanout,
 * SES email notifications for long-running jobs. Consumed by the
 * existing services/delivery/src/notify.ts Lambda (already written,
 * just not deployed until now).
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

    // --- SES: email notifications for long-running jobs (ARD §2.7) ---
    // Verification request only — see notificationSenderEmail doc comment.
    new ses.EmailIdentity(this, "SenderIdentity", {
      identity: ses.Identity.email(props.notificationSenderEmail),
    })

    // --- Lambda: consumes the bus, fans out to SNS + SES ---
    const notifyFn = new lambdaNode.NodejsFunction(this, "NotifyFn", {
      entry: path.join(REPO_ROOT, "services/delivery/src/notify.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: {
        WEBHOOK_TOPIC_ARN: this.webhookTopic.topicArn,
        NOTIFICATION_SENDER_EMAIL: props.notificationSenderEmail,
      },
      bundling: {},
      depsLockFilePath: BUN_LOCK_FILE,
      projectRoot: REPO_ROOT,
    })
    this.webhookTopic.grantPublish(notifyFn)
    notifyFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      })
    )

    new events.Rule(this, "JobCompleteRule", {
      eventBus: this.jobCompleteBus,
      eventPattern: { source: ["scrapeforge"], detailType: ["JobComplete"] },
      targets: [new targets.LambdaFunction(notifyFn)],
    })

    new CfnOutput(this, "JobCompleteBusName", {
      value: this.jobCompleteBus.eventBusName,
    })
    new CfnOutput(this, "WebhookTopicArn", {
      value: this.webhookTopic.topicArn,
    })
  }
}
