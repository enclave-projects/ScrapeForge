import { Stack, type StackProps } from "aws-cdk-lib"
import type * as ec2 from "aws-cdk-lib/aws-ec2"
import type { Construct } from "constructs"

export interface ProcessingStackProps extends StackProps {
  vpc: ec2.IVpc
}

/**
 * ARD §2.5: Readability/boilerplate-strip Lambda, dedup + change
 * detection, HTML→Markdown Lambda, structured-extract Lambda, Textract,
 * Rekognition, Bedrock. Not yet implemented — lands in the Processing
 * phase (blocked on Section 11 #1: Bedrock model choice).
 */
export class ProcessingStack extends Stack {
  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props)
    void props.vpc
  }
}
