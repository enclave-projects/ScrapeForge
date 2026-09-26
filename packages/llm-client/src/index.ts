import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"

/**
 * Model id is config-driven (TRD §2.6, Open Decision #1) — swap via env,
 * never hardcode a specific Bedrock model id in call sites.
 */
export interface LLMClientConfig {
  modelId: string
  region?: string
}

export interface LLMCompletionRequest {
  systemPrompt?: string
  messages: Message[]
  maxTokens?: number
}

export interface LLMClient {
  complete(request: LLMCompletionRequest): Promise<string>
}

export class BedrockLLMClient implements LLMClient {
  private readonly client: BedrockRuntimeClient
  private readonly modelId: string

  constructor(config: LLMClientConfig) {
    this.client = new BedrockRuntimeClient({ region: config.region })
    this.modelId = config.modelId
  }

  async complete(request: LLMCompletionRequest): Promise<string> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        messages: request.messages,
        system: request.systemPrompt
          ? [{ text: request.systemPrompt }]
          : undefined,
        inferenceConfig: { maxTokens: request.maxTokens ?? 2048 },
      })
    )

    const content = response.output?.message?.content?.[0]
    if (!content || !("text" in content) || !content.text) {
      throw new Error("Bedrock response contained no text content")
    }
    return content.text
  }
}
