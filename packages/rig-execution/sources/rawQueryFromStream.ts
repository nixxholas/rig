import type { Provider, RawQueryOptions } from "@/types.js";
import type { Context as RuntimeContext } from "@steve.kite/stdlib";

/**
 * Answers a bounded question through a provider's ordinary stream.
 *
 * Providers that own a vendor session answer these below the coding agent instead. This is what
 * the rest get: the instructions replace the model's base prompt, no tools are offered, and the
 * single turn is read to its end. A failed response carries no text, so it is raised as the
 * failure it was rather than returned as an empty answer.
 */
export async function rawQueryFromStream(
    ctx: RuntimeContext,
    provider: Pick<Provider, "stream">,
    options: RawQueryOptions,
): Promise<string> {
    const stream = provider.stream(
        ctx,
        options.model,
        {
            systemPromptOverride: options.instructions,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: options.prompt }],
                    timestamp: Date.now(),
                },
            ],
            tools: [],
        },
        {
            sessionId: options.sessionId,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
            thinking: "off",
        },
    );
    for await (const _event of stream) {
        // Drain the stream; the normalized final message is read below.
    }
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(
            message.errorMessage ?? "The provider ended the response without an answer.",
        );
    }
    return message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("")
        .trim();
}
