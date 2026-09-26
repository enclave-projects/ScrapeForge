import {
  Tags,
  Stack,
  type StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import * as backup from "aws-cdk-lib/aws-backup"
import * as opensearch from "aws-cdk-lib/aws-opensearchservice"
import * as rds from "aws-cdk-lib/aws-rds"
import type { Construct } from "constructs"

/** Resources tagged with this (value "true") are in the daily backup plan. */
export const BACKUP_TAG_KEY = "scrapeforge:backup"

export interface StorageStackProps extends StackProps {
  vpc: ec2.IVpc
  /**
   * OpenSearch and Aurora are real fixed-cost resources (~$72/mo
   * combined, no scale-to-zero) with nothing consuming them yet
   * (ProcessingStack doesn't exist). Defaults false so S3+DynamoDB can
   * deploy alone; flip true once ready to bring the rest online — this
   * only ever adds resources to the stack, never removes the ones
   * already deployed.
   */
  deployOpenSearchAndAurora?: boolean
}

/**
 * ARD §2.6 (Storage & Data Layer): S3 (raw HTML/screenshots + Markdown
 * output, with Glacier lifecycle), DynamoDB Page Metadata/ETags,
 * OpenSearch (full-text/vector search over Markdown), Aurora PostgreSQL
 * (accounts/billing/API keys/plans).
 *
 * This is the most expensive stack so far — OpenSearch and Aurora both
 * have real fixed monthly costs with no scale-to-zero option, unlike
 * everything deployed before it. Both are sized to the smallest viable
 * dev configuration (single-node OpenSearch, Aurora Serverless v2 at its
 * floor) rather than the ARD's Multi-AZ requirement, same cost-vs-
 * resilience tradeoff already made for NAT Gateway and Redis.
 */
export class StorageStack extends Stack {
  public readonly rawBucket: s3.Bucket
  public readonly markdownBucket: s3.Bucket
  public readonly pageMetadataTable: dynamodb.Table
  public readonly openSearchDomain?: opensearch.Domain
  public readonly auroraCluster?: rds.DatabaseCluster

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props)

    // --- S3: raw captures + Markdown output (ARD §2.6) ---
    this.rawBucket = new s3.Bucket(this, "RawBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Emits to the account's default EventBridge bus so ProcessingStack
      // can react to new objects without a direct S3->Lambda notification,
      // which would need this bucket's stack to reference the Lambda's
      // stack (ProcessingStack already depends on this one for the
      // bucket itself) - a cycle CloudFormation can't resolve.
      eventBridgeEnabled: true,
      lifecycleRules: [
        {
          id: "glacier-after-30-days",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY, // dev only
      autoDeleteObjects: true,
    })

    this.markdownBucket = new s3.Bucket(this, "MarkdownBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true, // ARD §2.6: "versioned per URL/crawl"
      removalPolicy: RemovalPolicy.DESTROY, // dev only
      autoDeleteObjects: true,
    })

    // --- DynamoDB: Page Metadata/ETags (ARD §2.6) ---
    // Matches services/processing/src/dedup.ts's Key: { accountId, url }.
    this.pageMetadataTable = new dynamodb.Table(this, "PageMetadataTable", {
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "url", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.DESTROY, // dev only
    })
    Tags.of(this.pageMetadataTable).add(BACKUP_TAG_KEY, "true")

    // --- DR (TRD §11 open decision #3, resolved: backups only, single
    // region). PITR covers the last 35 days to the second; this plan adds
    // daily snapshots kept 35 days. Selection is by tag so tables in
    // other stacks (the Jobs table) opt in without a cross-stack ref.
    // Markdown output is covered by its bucket's versioning; raw HTML is
    // re-fetchable and deliberately not backed up. ---
    const backupPlan = backup.BackupPlan.daily35DayRetention(this, "BackupPlan")
    backupPlan.addSelection("TaggedTables", {
      resources: [backup.BackupResource.fromTag(BACKUP_TAG_KEY, "true")],
    })

    new CfnOutput(this, "RawBucketName", { value: this.rawBucket.bucketName })
    new CfnOutput(this, "MarkdownBucketName", {
      value: this.markdownBucket.bucketName,
    })
    new CfnOutput(this, "PageMetadataTableName", {
      value: this.pageMetadataTable.tableName,
    })

    if (!props.deployOpenSearchAndAurora) {
      return
    }

    // --- OpenSearch: full-text/vector index over Markdown (ARD §2.6) ---
    // Single-node t3.small.search, not the Multi-AZ 3-node setup a
    // production domain would want — real fixed cost either way, this
    // is the cheapest viable size (~$26/mo + EBS).
    this.openSearchDomain = new opensearch.Domain(this, "SearchDomain", {
      version: opensearch.EngineVersion.OPENSEARCH_2_15,
      vpc: props.vpc,
      vpcSubnets: [
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, onePerAz: true },
      ],
      zoneAwareness: { enabled: false },
      capacity: {
        dataNodes: 1,
        dataNodeInstanceType: "t3.small.search",
      },
      ebs: { volumeSize: 20, volumeType: ec2.EbsDeviceVolumeType.GP3 },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      removalPolicy: RemovalPolicy.DESTROY, // dev only
    })

    // --- Aurora PostgreSQL: accounts/billing/API keys/plans (ARD §2.6) ---
    const dbCredentials =
      rds.Credentials.fromGeneratedSecret("scrapeforge_admin")
    this.auroraCluster = new rds.DatabaseCluster(this, "AuroraCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: dbCredentials,
      defaultDatabaseName: "scrapeforge",
      // Serverless v2 at its floor (0.5 ACU) — no Multi-AZ reader, single
      // writer instance. Real fixed cost (~$43/mo) with no scale-to-zero;
      // still the cheapest Aurora configuration available.
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      writer: rds.ClusterInstance.serverlessV2("Writer"),
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.DESTROY, // dev only
    })

    new CfnOutput(this, "OpenSearchEndpoint", {
      value: this.openSearchDomain.domainEndpoint,
    })
    new CfnOutput(this, "AuroraClusterEndpoint", {
      value: this.auroraCluster.clusterEndpoint.hostname,
    })
    new CfnOutput(this, "AuroraSecretArn", {
      value: this.auroraCluster.secret?.secretArn ?? "unknown",
    })
  }
}
