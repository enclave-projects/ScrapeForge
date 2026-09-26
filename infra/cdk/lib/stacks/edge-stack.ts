import { Stack, type StackProps } from "aws-cdk-lib"
import type { Construct } from "constructs"

/**
 * ARD §2.1: CloudFront, WAF+Shield, API Gateway (REST+WebSocket), Cognito.
 * Not yet implemented — lands in the Edge/Auth phase.
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props)
  }
}
