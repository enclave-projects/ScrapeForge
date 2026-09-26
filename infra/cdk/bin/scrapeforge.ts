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

const ingestion = new IngestionStack(app, stackName("IngestionStack"), {
  env,
  tags,
  httpApi: edge.httpApi,
  jwtAuthorizer: edge.jwtAuthorizer,
})

new FetchStack(app, stackName("FetchStack"), {
  env,
  tags,
  vpc: network.vpc,
  priorityQueue: ingestion.priorityQueue,
  bulkQueue: ingestion.bulkQueue,
  githubRepo: "enclave-projects/ScrapeForge",
  githubRef: "claude/scrapeforge-aws-deploy-pran3g",
})

new CacheStack(app, stackName("CacheStack"), { env, tags, vpc: network.vpc })

new ProcessingStack(app, stackName("ProcessingStack"), {
  env,
  tags,
  vpc: network.vpc,
})

new StorageStack(app, stackName("StorageStack"), {
  env,
  tags,
  vpc: network.vpc,
})

new DeliveryStack(app, stackName("DeliveryStack"), { env, tags })

new ObservabilityStack(app, stackName("ObservabilityStack"), { env, tags })
