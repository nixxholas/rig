import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";

export type AnthropicBedrockClient = Pick<AnthropicBedrock | AnthropicBedrockMantle, "beta">;

export function createAnthropicBedrockClient(options: {
    bearerToken: string;
    endpoint?: string;
    region: string;
    transport: AnthropicBedrockTransport;
    userAgent?: string;
}): AnthropicBedrockClient {
    const userAgent = options.userAgent?.trim();
    const clientOptions = {
        apiKey: options.bearerToken,
        awsRegion: options.region,
        maxRetries: 0,
        ...(options.endpoint === undefined ? {} : { baseURL: options.endpoint }),
        // Left to the SDK unless the caller would rather its traffic be recognizable as its own.
        ...(userAgent === undefined || userAgent.length === 0
            ? {}
            : { defaultHeaders: { "User-Agent": userAgent } }),
    };
    return options.transport === "mantle"
        ? new AnthropicBedrockMantle(clientOptions)
        : new AnthropicBedrock(clientOptions);
}
