import { Stack, type StackProps, Tags } from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import type { Construct } from "constructs"

export interface NetworkStackProps extends StackProps {
  /**
   * Number of NAT Gateways to provision. ARD §5.1 requires private-subnet
   * egress via NAT Gateway for Fargate fetch tasks. One per AZ is the
   * resilient default; dev environments may override to 1 to save cost
   * (~$32/mo per gateway) at the expense of a shared failure point.
   */
  natGateways?: number
}

/**
 * ARD §5.1 (Network): Multi-AZ VPC. Fargate fetch tasks run in private
 * subnets with NAT egress for scraping targets; stateful services
 * (Aurora, ElastiCache, OpenSearch — added in later stacks) run in
 * isolated subnets with no internet route at all. No component other
 * than API Gateway (EdgeStack) is internet-facing.
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc

  constructor(scope: Construct, id: string, props: NetworkStackProps = {}) {
    super(scope, id, props)

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 3,
      natGateways: props.natGateways ?? 1,
      ipAddresses: ec2.IpAddresses.cidr("10.20.0.0/16"),
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "private-egress",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 20,
        },
        {
          name: "private-isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 20,
        },
      ],
    })

    Tags.of(this.vpc).add("scrapeforge:component", "network")
  }
}
