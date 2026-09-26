/**
 * Model id is config-driven (TRD §2.6, Open Decision #1) — swap via env,
 * never hardcode a specific Bedrock model id in call sites.
 *
 * This talks to Bedrock through an OpenAI-compatible gateway ("Bedrock
 * Mantle" in this account), authenticated with a pre-provisioned
 * long-term API key — not the AWS SDK's BedrockRuntimeClient. That SDK
 * path was tried first (IAM service-specific credential, bearer-token
 * auth against the Converse/InvokeModel APIs) and hit a real account-
 * level block: model access wasn't authorized (EULA not accepted), a
 * business decision outside what CDK/IAM permissions can grant. This
 * gateway sidesteps that requirement entirely and was confirmed working
 * with a real request before wiring it in here.
 */
export interface LLMClientConfig {
  modelId: string
  /** e.g. https://bedrock-mantle.ap-south-1.api.aws/v1 */
  baseUrl: string
  apiKey: string
}

export interface LLMMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface LLMCompletionRequest {
  systemPrompt?: string
  messages: LLMMessage[]
  maxTokens?: number
}

export interface LLMClient {
  complete(request: LLMCompletionRequest): Promise<string>
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>
}

export class BedrockLLMClient implements LLMClient {
  constructor(private readonly config: LLMClientConfig) {}

  async complete(request: LLMCompletionRequest): Promise<string> {
    const messages: LLMMessage[] = request.systemPrompt
      ? [{ role: "system", content: request.systemPrompt }, ...request.messages]
      : request.messages

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.modelId,
        messages,
        max_tokens: request.maxTokens ?? 2048,
      }),
    })

    if (!response.ok) {
      throw new Error(
        `Bedrock gateway request failed: ${response.status} ${await response.text()}`
      )
    }

    const data = (await response.json()) as ChatCompletionResponse
    const content = data.choices[0]?.message.content
    if (!content) {
      throw new Error("Bedrock gateway response contained no text content")
    }
    return content
  }
}
