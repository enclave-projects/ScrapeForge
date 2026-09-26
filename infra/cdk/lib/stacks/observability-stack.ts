import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions"
import * as sns from "aws-cdk-lib/aws-sns"
import type * as sqs from "aws-cdk-lib/aws-sqs"
import type * as sfn from "aws-cdk-lib/aws-stepfunctions"
import type * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs"
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2"
import type { Construct } from "constructs"

export interface ObservabilityStackProps extends StackProps {
  httpApi: apigwv2.HttpApi
  priorityQueue: sqs.IQueue
  bulkQueue: sqs.IQueue
  priorityDlq: sqs.IQueue
  bulkDlq: sqs.IQueue
  stateMachine: sfn.StateMachine
  routerFn: lambdaNode.NodejsFunction
}

/**
 * ARD §2.8 (Observability & Ops): CloudWatch metrics/logs/alarms (queue
 * depth, error rates, latency) and X-Ray tracing.
 *
 * X-Ray itself isn't configured here — it's already turned on at the
 * source in every stack that needed it (Lambda Powertools tracer in the
 * services, `tracingEnabled: true` on the CrawlOrchestrator state
 * machine). This stack is the cross-cutting layer on top: alarms for
 * conditions no single resource's own config can express (DLQ depth,
 * API 5xx rate, Step Functions failures) and one dashboard to see them
 * together.
 *
 * Alarms publish to a dedicated OpsAlerts SNS topic, separate from
 * DeliveryStack's customer-facing webhook topic. No subscription is
 * wired up — add an email/Slack/PagerDuty subscription to
 * `opsAlertsTopic` once you know where these should actually go.
 */
export class ObservabilityStack extends Stack {
  public readonly opsAlertsTopic: sns.Topic

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props)

    this.opsAlertsTopic = new sns.Topic(this, "OpsAlertsTopic", {
      displayName: "ScrapeForge ops alerts (dev)",
    })
    const alarmAction = new cwActions.SnsAction(this.opsAlertsTopic)

    // --- Alarms: poison messages (ARD §6 dead-letter queues) ---
    const priorityDlqAlarm = new cloudwatch.Alarm(this, "PriorityDlqAlarm", {
      metric: props.priorityDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Priority queue DLQ has messages - single-URL requests are failing repeatedly",
    })
    priorityDlqAlarm.addAlarmAction(alarmAction)

    const bulkDlqAlarm = new cloudwatch.Alarm(this, "BulkDlqAlarm", {
      metric: props.bulkDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Bulk crawl queue DLQ has messages - crawl page fetches are failing repeatedly",
    })
    bulkDlqAlarm.addAlarmAction(alarmAction)

    // --- Alarm: Router Lambda errors ---
    const routerErrorsAlarm = new cloudwatch.Alarm(this, "RouterErrorsAlarm", {
      metric: props.routerFn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Request Validator + Router Lambda is erroring on incoming requests",
    })
    routerErrorsAlarm.addAlarmAction(alarmAction)

    // --- Alarm: Crawl Orchestrator failures ---
    const stateMachineFailuresAlarm = new cloudwatch.Alarm(
      this,
      "StateMachineFailuresAlarm",
      {
        metric: props.stateMachine.metricFailed({
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: "Crawl Orchestrator state machine execution failed",
      }
    )
    stateMachineFailuresAlarm.addAlarmAction(alarmAction)

    // --- Alarm: API Gateway 5xx rate ---
    const api5xxAlarm = new cloudwatch.Alarm(this, "Api5xxAlarm", {
      metric: props.httpApi.metricServerError({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "HTTP API returning 5xx errors",
    })
    api5xxAlarm.addAlarmAction(alarmAction)

    // --- Dashboard: the metrics behind the alarms above, in one place ---
    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: "ScrapeForge-dev",
    })
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Queue depth",
        left: [
          props.priorityQueue.metricApproximateNumberOfMessagesVisible(),
          props.bulkQueue.metricApproximateNumberOfMessagesVisible(),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "DLQ depth (should stay at 0)",
        left: [
          props.priorityDlq.metricApproximateNumberOfMessagesVisible(),
          props.bulkDlq.metricApproximateNumberOfMessagesVisible(),
        ],
      })
    )
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Router Lambda",
        left: [
          props.routerFn.metricInvocations(),
          props.routerFn.metricErrors(),
        ],
        right: [props.routerFn.metricDuration()],
      }),
      new cloudwatch.GraphWidget({
        title: "HTTP API",
        left: [
          props.httpApi.metricCount(),
          props.httpApi.metricServerError(),
          props.httpApi.metricClientError(),
        ],
        right: [props.httpApi.metricLatency()],
      })
    )
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Crawl Orchestrator executions",
        left: [
          props.stateMachine.metricStarted(),
          props.stateMachine.metricSucceeded(),
          props.stateMachine.metricFailed(),
        ],
      })
    )

    new CfnOutput(this, "OpsAlertsTopicArn", {
      value: this.opsAlertsTopic.topicArn,
    })
    new CfnOutput(this, "DashboardUrl", {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    })
  }
}
