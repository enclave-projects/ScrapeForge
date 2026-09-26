import { Stack, type StackProps } from "aws-cdk-lib"
import type { Construct } from "constructs"

/**
 * ARD §2.8: CloudWatch dashboards/alarms, X-Ray tracing config.
 * Not yet implemented — lands in the Observability phase.
 */
export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props)
  }
}
