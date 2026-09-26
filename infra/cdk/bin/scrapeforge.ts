import { App } from "aws-cdk-lib"
import { NetworkStack } from "../lib/stacks/network-stack.js"
import { EdgeStack } from "../lib/stacks/edge-stack.js"
import { IngestionStack } from "../lib/stacks/ingestion-stack.js"
import { FetchStack } from "../lib/stacks/fetch-stack.js"
import { CacheStack } from "../lib/stacks/cache-stack.js"
import { ProcessingStack } from "../lib/stacks/processing-stack.js"
import { StorageStack } from "../lib/stacks/storage-stack.js"
import { DeliveryStack } from "../lib/stacks/delivery-stack.js"
import { ObservabilityStack } from "../lib/stacks/observability-stack.js"

/**
 * ARD §7: `dev` is the only environment wired up so far. `staging`/`prod`
 * are separate AWS accounts (AWS Organizations) that do not exist yet.
 */
const ENVIRONMENT = "dev"

const app = new App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}

const stackName = (name: string) => `ScrapeForge-${ENVIRONMENT}-${name}`
const tags = { "scrapeforge:environment": ENVIRONMENT }

const network = new NetworkStack(app, stackName("NetworkStack"), {
  env,
  tags,
  // Single NAT Gateway in dev to save ~$32/mo per additional AZ; revisit
  // for staging/prod where cross-AZ NAT resilience matters more.
  natGateways: 1,
})

const edge = new EdgeStack(app, stackName("EdgeStack"), { env, tags })

const cache = new CacheStack(app, stackName("CacheStack"), {
  env,
  tags,
  vpc: network.vpc,
})

const storage = new StorageStack(app, stackName("StorageStack"), {
  env,
  tags,
  vpc: network.vpc,
  // OpenSearch + Aurora deliberately held back until ProcessingStack
  // actually needs them — see StorageStack's prop doc comment.
  deployOpenSearchAndAurora: false,
})

const ingestion = new IngestionStack(app, stackName("IngestionStack"), {
  env,
  tags,
  httpApi: edge.httpApi,
  jwtAuthorizer: edge.jwtAuthorizer,
  vpc: network.vpc,
  redisEndpoint: cache.redisEndpoint,
  redisPort: cache.redisPort,
  markdownBucket: storage.markdownBucket,
})

new FetchStack(app, stackName("FetchStack"), {
  env,
  tags,
  vpc: network.vpc,
  priorityQueue: ingestion.priorityQueue,
  bulkQueue: ingestion.bulkQueue,
  rawBucket: storage.rawBucket,
  githubRepo: "enclave-projects/ScrapeForge",
  githubRef: "claude/scrapeforge-aws-deploy-pran3g",
})

const delivery = new DeliveryStack(app, stackName("DeliveryStack"), {
  env,
  tags,
  // enclaveprojects.dev is the verified sending domain in the Resend account.
  notificationSender: "ScrapeForge <notifications@enclaveprojects.dev>",
})

new ProcessingStack(app, stackName("ProcessingStack"), {
  env,
  tags,
  vpc: network.vpc,
  rawBucket: storage.rawBucket,
  markdownBucket: storage.markdownBucket,
  pageMetadataTable: storage.pageMetadataTable,
  redisEndpoint: cache.redisEndpoint,
  redisPort: cache.redisPort,
  jobCompleteBus: delivery.jobCompleteBus,
  jobsTable: ingestion.jobsTable,
})

new ObservabilityStack(app, stackName("ObservabilityStack"), {
  env,
  tags,
  httpApi: edge.httpApi,
  priorityQueue: ingestion.priorityQueue,
  bulkQueue: ingestion.bulkQueue,
  priorityDlq: ingestion.priorityDlq,
  bulkDlq: ingestion.bulkDlq,
  stateMachine: ingestion.stateMachine,
  routerFn: ingestion.routerFn,
})
