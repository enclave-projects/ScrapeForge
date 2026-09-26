import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib"
import * as cognito from "aws-cdk-lib/aws-cognito"
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2"
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers"
import * as wafv2 from "aws-cdk-lib/aws-wafv2"
import * as cloudfront from "aws-cdk-lib/aws-cloudfront"
import * as origins from "aws-cdk-lib/aws-cloudfront-origins"
import type { Construct } from "constructs"

/**
 * ARD §2.1 (Edge/Perimeter): CloudFront, WAF, API Gateway (HTTP + WebSocket
 * APIs via aws-apigatewayv2 per TRD §2.1), Cognito.
 *
 * Open items intentionally NOT decided here (flagged rather than guessed):
 * - Dashboard static hosting behind CloudFront is not wired up — the TRD
 *   specifies Next.js for apps/dashboard but does not say how it's hosted
 *   (S3+CloudFront static export vs. SSR on ECS/Amplify/Vercel), so this
 *   stack only fronts the API for now.
 * - Per-plan-tier rate-limit *values* (TRD §11 open decision #4) are still
 *   unset. The WAF rate-based rule below throttles abusive traffic at the
 *   edge (a security control); it is not the product's per-plan API rate
 *   limit, which belongs in IngestionStack/API Gateway usage plans once
 *   those numbers are provided.
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

    // --- WAF: regional WebACL in front of the HTTP API (ARD §5.3) ---
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: "ScrapeForgeWebAcl",
      },
      rules: [
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "CommonRuleSet",
          },
        },
        {
          name: "AWS-AWSManagedRulesBotControlRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesBotControlRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "BotControl",
          },
        },
        {
          // Edge-level anti-abuse throttle — NOT the product's per-plan
          // rate limit (TRD §11 #4, still unset). Placeholder value.
          name: "RateLimitPerIp",
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "RateLimitPerIp",
          },
        },
      ],
    })

    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: `arn:aws:apigateway:${this.region}::/apis/${this.httpApi.apiId}/stages/$default`,
      webAclArn: webAcl.attrArn,
    })

    // --- CloudFront: edge caching in front of the HTTP API (ARD §2.1) ---
    const apiDomain = `${this.httpApi.apiId}.execute-api.${this.region}.amazonaws.com`
    new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment:
        "ScrapeForge API edge cache (dev) — dashboard hosting not yet wired up",
      defaultRootObject: undefined,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: false,
    })

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
