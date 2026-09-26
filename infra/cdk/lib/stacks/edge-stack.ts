import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib"
import * as cognito from "aws-cdk-lib/aws-cognito"
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2"
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers"
import type { Construct } from "constructs"

/**
 * ARD §2.1 (Edge/Perimeter): CloudFront, WAF, API Gateway (HTTP + WebSocket
 * APIs via aws-apigatewayv2 per TRD §2.1), Cognito.
 *
 * CloudFront and WAF are TEMPORARILY OMITTED from this stack:
 * - CloudFront: this AWS account is not yet verified for CloudFront usage
 *   ("Access denied ... Your account must be verified ... contact AWS
 *   Support"). Needs an AWS Support case before it can be added back.
 * - WAF: AWS::WAFv2::WebACLAssociation does not support HttpApi (v2) at
 *   all — only REST API v1 stages, ALB, CloudFront, AppSync, Cognito.
 *   Once CloudFront is unblocked, WAF should attach there instead (as a
 *   CLOUDFRONT-scope WebACL, which AWS requires to live in us-east-1
 *   regardless of this stack's region — a cross-region construct not yet
 *   built) rather than directly on the HTTP API stage.
 *
 * Other open items intentionally NOT decided here (flagged rather than
 * guessed):
 * - Dashboard static/SSR hosting is undecided — the TRD specifies Next.js
 *   for apps/dashboard but not how it's hosted, so nothing fronts it yet.
 * - Per-plan-tier rate-limit values (TRD §11 open decision #4) are still
 *   unset; when WAF comes back its rate-based rule limit is a separate,
 *   edge-level anti-abuse value, not the product's per-plan API limit.
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

    // WAF and CloudFront deliberately omitted — see class doc comment.

    new CfnOutput(this, "HttpApiUrl", { value: this.httpApi.apiEndpoint })
    new CfnOutput(this, "WebSocketApiUrl", {
      value: this.webSocketApi.apiEndpoint,
    })
    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId })
    new CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    })
  }
}
