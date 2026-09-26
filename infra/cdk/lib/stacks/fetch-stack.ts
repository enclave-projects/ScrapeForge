import { Stack, type StackProps } from "aws-cdk-lib"
import type * as ec2 from "aws-cdk-lib/aws-ec2"
import type { Construct } from "constructs"

export interface FetchStackProps extends StackProps {
  vpc: ec2.IVpc
}

/**
 * ARD §2.3: Fargate Fast HTTP Fetcher pool, Fargate Headless Browser
 * pool, Proxy + Anti-Bot Manager, Application Auto Scaling on SQS depth,
 * Secrets Manager. Not yet implemented — lands in the Fetch tier phase.
 */
export class FetchStack extends Stack {
  constructor(scope: Construct, id: string, props: FetchStackProps) {
    super(scope, id, props)
    void props.vpc
  }
}
