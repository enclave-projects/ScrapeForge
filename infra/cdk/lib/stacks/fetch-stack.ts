import {
  Stack,
  type StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as iam from "aws-cdk-lib/aws-iam"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as applicationautoscaling from "aws-cdk-lib/aws-applicationautoscaling"
import type * as sqs from "aws-cdk-lib/aws-sqs"
import type * as s3 from "aws-cdk-lib/aws-s3"
import type { Construct } from "constructs"

export interface FetchStackProps extends StackProps {
  vpc: ec2.IVpc
  priorityQueue: sqs.IQueue
  bulkQueue: sqs.IQueue
  rawBucket: s3.IBucket
  /** GitHub repo allowed to assume the CI push role, "owner/repo" form. */
  githubRepo: string
  /** Git ref (e.g. a branch) allowed to assume the CI push role. */
  githubRef: string
}

/**
 * ARD §2.3 (Fetch/Render Tier): Fargate Fast HTTP Fetchers, Fargate
 * Headless Browser Pool, Proxy + Anti-Bot Manager (implemented as Secrets
 * Manager-backed config read by both pools, not a separate service —
 * ARD doesn't specify its own compute for this), Application Auto
 * Scaling on SQS depth, Secrets Manager for proxy credentials.
 *
 * Container images are NOT built here. This CDK app runs in a sandboxed
 * session with no Docker daemon available (nested containers aren't
 * permitted), so per TRD §5 ("Container images built via Docker, pushed
 * to ECR, referenced by tag in CDK") image builds are GitHub Actions'
 * job — see .github/workflows/build-fetch-images.yml. This stack creates
 * the ECR repos and the OIDC role that workflow assumes to push into
 * them, and references whatever tag was last pushed (`latest` by
 * default) in the task definitions.
 */
export class FetchStack extends Stack {
  public readonly fastHttpRepo: ecr.Repository
  public readonly headlessRepo: ecr.Repository
  public readonly githubActionsRole: iam.Role

  constructor(scope: Construct, id: string, props: FetchStackProps) {
    super(scope, id, props)

    // --- ECR repositories for the two fetch-tier container images ---
    this.fastHttpRepo = new ecr.Repository(this, "FastHttpRepo", {
      repositoryName: "scrapeforge-fetch-http",
      removalPolicy: RemovalPolicy.DESTROY, // dev only
      emptyOnDelete: true,
      imageScanOnPush: true,
    })

    this.headlessRepo = new ecr.Repository(this, "HeadlessRepo", {
      repositoryName: "scrapeforge-fetch-headless",
      removalPolicy: RemovalPolicy.DESTROY, // dev only
      emptyOnDelete: true,
      imageScanOnPush: true,
    })

    // --- GitHub Actions OIDC: lets the workflow push images without static AWS keys ---
    const githubOidcProvider = new iam.OpenIdConnectProvider(
      this,
      "GithubOidcProvider",
      {
        url: "https://token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
      }
    )

    // This environment's GitHub issues OIDC "sub" claims as
    // repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/<branch> —
    // numeric IDs appended to owner/repo, unlike the standard
    // repo:<owner>/<repo>:ref:... format most GitHub docs show. Confirmed
    // by decoding the actual token in a debug workflow step; wildcards
    // cover the IDs so this doesn't need updating if they ever change.
    const [githubOwner, githubRepoName] = props.githubRepo.split("/")
    this.githubActionsRole = new iam.Role(this, "GithubActionsEcrPushRole", {
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": `repo:${githubOwner}@*/${githubRepoName}@*:ref:refs/heads/${props.githubRef}`,
          },
        }
      ),
      description:
        "Assumed by GitHub Actions to build+push fetch-tier images to ECR (no static AWS keys).",
    })
    this.fastHttpRepo.grantPullPush(this.githubActionsRole)
    this.headlessRepo.grantPullPush(this.githubActionsRole)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"], // GetAuthorizationToken does not support resource-level scoping
      })
    )

    // --- Secrets Manager: proxy credentials, injected at runtime (ARD §5.2) ---
    const proxyCredentialsSecret = new secretsmanager.Secret(
      this,
      "ProxyCredentials",
      {
        description:
          "Proxy/anti-bot vendor credentials for the fetch tier — populate manually, never in code.",
        removalPolicy: RemovalPolicy.DESTROY, // dev only
      }
    )

    // --- ECS cluster + task execution role (shared by both pools) ---
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      containerInsights: true,
    })

    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    })

    // --- Fast HTTP Fetcher pool ---
    const fastHttpTask = new ecs.FargateTaskDefinition(
      this,
      "FastHttpTaskDef",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: taskExecutionRole,
      }
    )
    const fastHttpContainer = fastHttpTask.addContainer("FastHttpContainer", {
      image: ecs.ContainerImage.fromEcrRepository(this.fastHttpRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "fetch-http" }),
      environment: {
        QUEUE_URL: props.priorityQueue.queueUrl,
        RAW_HTML_BUCKET_NAME: props.rawBucket.bucketName,
        HEADLESS_QUEUE_URL: props.bulkQueue.queueUrl,
      },
      secrets: {
        PROXY_CREDENTIALS: ecs.Secret.fromSecretsManager(
          proxyCredentialsSecret
        ),
      },
    })
    void fastHttpContainer
    props.priorityQueue.grantConsumeMessages(fastHttpTask.taskRole)
    props.bulkQueue.grantSendMessages(fastHttpTask.taskRole)
    props.rawBucket.grantPut(fastHttpTask.taskRole)
    proxyCredentialsSecret.grantRead(fastHttpTask.taskRole)

    const fastHttpService = new ecs.FargateService(this, "FastHttpService", {
      cluster,
      taskDefinition: fastHttpTask,
      // Scaling steps below cover 0 -> N and N -> 0 both, so the baseline
      // desired count is 0: cost is $0 at idle, not a fixed always-on task.
      desiredCount: 0,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 50,
    })

    const fastHttpScaling = fastHttpService.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 10,
    })
    fastHttpScaling.scaleOnMetric("ScaleOnPriorityQueueDepth", {
      metric: props.priorityQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 1, change: -1 },
        { lower: 1, upper: 20, change: +1 },
        { lower: 20, change: +3 },
      ],
      cooldown: Duration.seconds(60),
    })

    // --- Headless Browser Pool (Playwright fallback) ---
    const headlessTask = new ecs.FargateTaskDefinition(
      this,
      "HeadlessTaskDef",
      {
        cpu: 1024,
        memoryLimitMiB: 3072, // Playwright/Chromium needs headroom
        executionRole: taskExecutionRole,
      }
    )
    const headlessContainer = headlessTask.addContainer("HeadlessContainer", {
      image: ecs.ContainerImage.fromEcrRepository(this.headlessRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "fetch-headless" }),
      environment: {
        QUEUE_URL: props.bulkQueue.queueUrl,
        RAW_HTML_BUCKET_NAME: props.rawBucket.bucketName,
      },
      secrets: {
        PROXY_CREDENTIALS: ecs.Secret.fromSecretsManager(
          proxyCredentialsSecret
        ),
      },
    })
    void headlessContainer
    props.bulkQueue.grantConsumeMessages(headlessTask.taskRole)
    props.rawBucket.grantPut(headlessTask.taskRole)
    proxyCredentialsSecret.grantRead(headlessTask.taskRole)

    const headlessService = new ecs.FargateService(this, "HeadlessService", {
      cluster,
      taskDefinition: headlessTask,
      // Same reasoning as FastHttpService: symmetric scaling steps mean
      // desiredCount 0 is a real idle state, not a placeholder.
      desiredCount: 0,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 50,
    })

    const headlessScaling = headlessService.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 5,
    })
    headlessScaling.scaleOnMetric("ScaleOnBulkQueueDepth", {
      metric: props.bulkQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 1, change: -1 },
        { lower: 1, upper: 20, change: +1 },
        { lower: 20, change: +2 },
      ],
      cooldown: Duration.seconds(60),
    })

    new CfnOutput(this, "FastHttpRepoUri", {
      value: this.fastHttpRepo.repositoryUri,
    })
    new CfnOutput(this, "HeadlessRepoUri", {
      value: this.headlessRepo.repositoryUri,
    })
    new CfnOutput(this, "GithubActionsRoleArn", {
      value: this.githubActionsRole.roleArn,
    })
  }
}
