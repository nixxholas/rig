import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import {
    createAnthropicBedrockClient,
    type AnthropicBedrockClient,
} from "@/vendors/bedrock/impl/createAnthropicBedrockClient.js";

/**
 * The Bedrock client a session talks through, built once and kept.
 *
 * Bedrock authenticates with a bearer token the SDK captures at construction, so the client is
 * created on first use rather than in the constructor — a session may be built before its
 * credential is ready. Callers that need the client itself, such as native compaction, borrow it
 * through {@link client}; everything else goes out over {@link stream}.
 */
export class AnthropicBedrockConnection {
    private cached: AnthropicBedrockClient | undefined;

    constructor(
        private readonly options: {
            bearerToken: () => string;
            client?: AnthropicBedrockClient;
            endpoint?: string;
            region: string;
            transport: AnthropicBedrockTransport;
            userAgent?: string;
        },
    ) {
        this.cached = options.client;
    }

    client(): AnthropicBedrockClient {
        return (this.cached ??= createAnthropicBedrockClient({
            bearerToken: this.options.bearerToken(),
            ...(this.options.endpoint === undefined ? {} : { endpoint: this.options.endpoint }),
            region: this.options.region,
            transport: this.options.transport,
            ...(this.options.userAgent === undefined ? {} : { userAgent: this.options.userAgent }),
        }));
    }

    stream(
        request: Parameters<AnthropicBedrockClient["beta"]["messages"]["create"]>[0],
        signal?: AbortSignal,
    ): Promise<AsyncIterable<BetaRawMessageStreamEvent>> {
        return this.client().beta.messages.create(
            request,
            signal === undefined ? undefined : { signal },
        ) as Promise<AsyncIterable<BetaRawMessageStreamEvent>>;
    }

    close(): void {
        this.cached = undefined;
    }
}
