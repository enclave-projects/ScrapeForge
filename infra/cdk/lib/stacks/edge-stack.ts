import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib"
import * as cognito from "aws-cdk-lib/aws-cognito"
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2"
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers"
import * as wafv2 from "aws-cdk-lib/aws-wafv2"
import * as amplify from "aws-cdk-lib/aws-amplify"
import type { Construct } from "constructs"

/**
 * ARD §2.1 (Edge/Perimeter): CloudFront, WAF, API Gateway (HTTP + WebSocket
 * APIs via aws-apigatewayv2 per TRD §2.1), Cognito.
 *
 * CloudFront is unavailable: this AWS account isn't verified for it
 * ("Your account must be verified ... contact AWS Support"). Until an
 * AWS Support case clears that, the edge works without it:
 * - The HTTP API is served directly from its regional execute-api
 *   endpoint, with a stage-wide throttle as a cost/abuse ceiling. That's
 *   an aggregate cap, not per-client: per-account limits are enforced by
 *   the Router Lambda (per-plan token buckets in Redis).
 * - WAF can't attach to an HTTP API (WAFv2 supports REST API stages,
 *   ALB, CloudFront, AppSync, Cognito, App Runner, Verified Access), so
 *   a REGIONAL WebACL guards the Cognito user pool instead: a per-IP
 *   rate rule against sign-up/sign-in brute force and bulk sign-ups,
 *   which is the unauthenticated surface. Every API route already
 *   requires a valid Cognito JWT, rejected at API Gateway before any
 *   Lambda runs.
 * - The dashboard (a static Next.js export) is hosted on Amplify
 *   Hosting, which serves HTTPS from AWS-managed infrastructure and so
 *   needs no CloudFront distribution in this account. Content is pushed
 *   with a manual deployment (no Git connection), see DashboardAppId.
 * Once CloudFront is unblocked, a CLOUDFRONT-scope WebACL (us-east-1)
 * in front of both would replace this.
 *
 * Also:
 * - Per-plan API limits (TRD §11 #4) live in services/api-router, not
 *   here; the throttle and WAF values below are edge-level anti-abuse
 *   ceilings, a separate concern.
 * - Shield Standard is automatic on CloudFront/API Gateway and has no CDK
 *   resource; Shield Advanced (paid, ~$3,000/mo) is not enabled.
 */
export class EdgeStack extends Stack {
  public readonly userPool: cognito.UserPool
  public readonly userPoolClient: cognito.UserPoolClient
  public readonly httpApi: apigwv2.HttpApi
  public readonly jwtAuthorizer: authorizers.HttpUserPoolAuthorizer
  public readonly webSocketApi: apigwv2.WebSocketApi

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props)

    // --- Cognito: auth + API key issuance (ARD §2.1, §5.2) ---
    this.userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    })

    this.userPoolClient = this.userPool.addClient("DashboardClient", {
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
      },
    })

    this.jwtAuthorizer = new authorizers.HttpUserPoolAuthorizer(
      "ApiAuthorizer",
      this.userPool,
      {
        userPoolClients: [this.userPoolClient],
      }
    )

    // --- API Gateway: HTTP API for request/response, WebSocket for job-status streaming (ARD §2.1) ---
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "scrapeforge-api",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ["authorization", "content-type"],
      },
      // Routes (single-URL scrape, crawl, job status) are added in
      // IngestionStack once the Router Lambda exists, via
      // httpApi.addRoutes(...) against this exported construct.
    })

    this.webSocketApi = new apigwv2.WebSocketApi(this, "WebSocketApi", {
      apiName: "scrapeforge-job-status",
      // $connect/$disconnect/$default routes wired up in IngestionStack.
    })
    new apigwv2.WebSocketStage(this, "WebSocketDefaultStage", {
      webSocketApi: this.webSocketApi,
      stageName: "prod",
      autoDeploy: true,
    })

    // Aggregate ceiling for the whole API (AWS's account default is
    // 10,000 rps): comfortably above many accounts at the top plan's
    // 100 rps, low enough to cap runaway cost.
    const defaultStage = this.httpApi.defaultStage?.node
      .defaultChild as apigwv2.CfnStage
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 1000,
      throttlingBurstLimit: 2000,
    }

    // --- WAF on Cognito (see class doc comment for why not the API) ---
    const authWebAcl = new wafv2.CfnWebACL(this, "AuthWebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "scrapeforge-auth",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "PerIpRateLimit",
          priority: 0,
          action: { block: {} },
          // Requests per IP per 5-minute window; generous for real
          // sign-ins (token refreshes included), blocks scripted abuse.
          statement: {
            rateBasedStatement: { limit: 300, aggregateKeyType: "IP" },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "scrapeforge-auth-rate-limit",
            sampledRequestsEnabled: true,
          },
        },
      ],
    })
    new wafv2.CfnWebACLAssociation(this, "AuthWebAclAssociation", {
      resourceArn: this.userPool.userPoolArn,
      webAclArn: authWebAcl.attrArn,
    })

    // --- Dashboard hosting (static export, manual deployments) ---
    const dashboardApp = new amplify.CfnApp(this, "DashboardApp", {
      name: "scrapeforge-dashboard",
      platform: "WEB",
    })
    const dashboardBranch = new amplify.CfnBranch(this, "DashboardBranch", {
      appId: dashboardApp.attrAppId,
      branchName: "main",
      stage: "DEVELOPMENT",
    })

    new CfnOutput(this, "HttpApiUrl", { value: this.httpApi.apiEndpoint })
    new CfnOutput(this, "WebSocketApiUrl", {
      value: this.webSocketApi.apiEndpoint,
    })
    new CfnOutput(this, "DashboardAppId", { value: dashboardApp.attrAppId })
    new CfnOutput(this, "DashboardUrl", {
      value: `https://${dashboardBranch.branchName}.${dashboardApp.attrDefaultDomain}`,
    })
    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId })
    new CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    })
  }
}
