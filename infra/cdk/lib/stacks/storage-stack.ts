import { Stack, type StackProps } from "aws-cdk-lib"
import type * as ec2 from "aws-cdk-lib/aws-ec2"
import type { Construct } from "constructs"

export interface StorageStackProps extends StackProps {
  vpc: ec2.IVpc
}

/**
 * ARD §2.6: S3 (raw HTML/screenshots + Markdown output), S3 Glacier
 * lifecycle, DynamoDB Page Metadata/ETags, OpenSearch, Aurora
 * PostgreSQL. Not yet implemented — lands in the Storage phase.
 * Aurora + OpenSearch are the largest fixed monthly costs in this
 * architecture — cost will be quoted before deploy.
 */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props)
    void props.vpc
  }
}
