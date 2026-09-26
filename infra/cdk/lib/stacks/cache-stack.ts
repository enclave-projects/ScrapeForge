import { Stack, type StackProps } from "aws-cdk-lib"
import type * as ec2 from "aws-cdk-lib/aws-ec2"
import type { Construct } from "constructs"

export interface CacheStackProps extends StackProps {
  vpc: ec2.IVpc
}

/**
 * ARD §2.4: ElastiCache Redis — dedup index, rate-limit counters,
 * hot-page cache. Not yet implemented — lands in the Cache phase.
 * Billable (Multi-AZ Redis, no free tier) — cost will be quoted before
 * deploy.
 */
export class CacheStack extends Stack {
  constructor(scope: Construct, id: string, props: CacheStackProps) {
    super(scope, id, props)
    void props.vpc
  }
}
