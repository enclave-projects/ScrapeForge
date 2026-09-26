import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as elasticache from "aws-cdk-lib/aws-elasticache"
import type { Construct } from "constructs"

export interface CacheStackProps extends StackProps {
  vpc: ec2.IVpc
}

/**
 * ARD §2.4 (Cache Layer): ElastiCache Redis — dedup index (URL → content
 * hash), rate-limit counters, hot-page cache for repeat single-URL
 * requests. Deployed into the VPC's private-isolated subnets (no
 * internet route at all, per ARD §5.1).
 *
 * Single node, no Multi-AZ, in dev — ARD §6 calls for Multi-AZ on all
 * stateful services, but that means a 2-node replication group here
 * (roughly double the cost for automatic failover this environment
 * doesn't need yet). `multiAz` defaults false; flip it for staging/prod.
 *
 * Security group is opened to the whole VPC CIDR rather than scoped to
 * specific peer security groups, because the services that will connect
 * (ProcessingStack's Lambdas, FetchStack's Fargate tasks for rate
 * limiting) either don't exist yet or weren't wired with their own SGs
 * for this — worth tightening once ProcessingStack exists.
 */
export class CacheStack extends Stack {
  public readonly redisEndpoint: string
  public readonly redisPort: string
  public readonly securityGroup: ec2.SecurityGroup

  constructor(
    scope: Construct,
    id: string,
    props: CacheStackProps & { multiAz?: boolean }
  ) {
    super(scope, id, props)

    const subnetGroup = new elasticache.CfnSubnetGroup(this, "SubnetGroup", {
      description: "ScrapeForge Redis subnet group (private-isolated)",
      subnetIds: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }).subnetIds,
    })

    this.securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: props.vpc,
      description: "ScrapeForge Redis — allows 6379 from within the VPC",
      allowAllOutbound: false,
    })
    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      "Redis from anywhere in the VPC"
    )

    const multiAz = props.multiAz ?? false

    const replicationGroup = new elasticache.CfnReplicationGroup(
      this,
      "Redis",
      {
        replicationGroupDescription:
          "ScrapeForge dedup index, rate limits, hot-page cache",
        engine: "redis",
        engineVersion: "7.1",
        cacheNodeType: "cache.t4g.micro",
        numCacheClusters: multiAz ? 2 : 1,
        automaticFailoverEnabled: multiAz,
        multiAzEnabled: multiAz,
        cacheSubnetGroupName: subnetGroup.ref,
        securityGroupIds: [this.securityGroup.securityGroupId],
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        transitEncryptionMode: "preferred", // TLS without requiring an auth token
      }
    )
    replicationGroup.addDependency(subnetGroup)

    this.redisEndpoint = replicationGroup.attrPrimaryEndPointAddress
    this.redisPort = replicationGroup.attrPrimaryEndPointPort

    new CfnOutput(this, "RedisEndpoint", { value: this.redisEndpoint })
    new CfnOutput(this, "RedisPort", { value: this.redisPort })
  }
}
