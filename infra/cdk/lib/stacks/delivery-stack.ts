import { Stack, type StackProps } from "aws-cdk-lib"
import type { Construct } from "constructs"

/**
 * ARD §2.7: job-complete EventBridge bus, SNS webhook fanout, SES email
 * notifications. Not yet implemented — lands in the Delivery phase.
 */
export class DeliveryStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props)
  }
}
