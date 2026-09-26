import { Stack, type StackProps } from "aws-cdk-lib"
import type * as ec2 from "aws-cdk-lib/aws-ec2"
import type { Construct } from "constructs"

export interface IngestionStackProps extends StackProps {
  vpc: ec2.IVpc
}

/**
 * ARD §2.2: Request Validator + Router Lambda, Crawl Orchestrator Step
 * Functions, EventBridge Scheduler, Priority/Bulk SQS queues, Jobs +
 * Crawl State DynamoDB table. Not yet implemented — lands in the
 * Ingestion/Orchestration phase.
 */
export class IngestionStack extends Stack {
  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props)
    void props.vpc
  }
}
