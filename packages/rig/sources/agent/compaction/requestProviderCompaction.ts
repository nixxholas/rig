import type { Context, Model, Provider, Usage } from "@slopus/rig-execution";

/**
 * What a provider gives back when it compacts a conversation.
 *
 * Native providers own the complete replacement context. A readable summary is optional and is
 * never synthesized by Rig.
 */
export interface ProviderCompaction {
    context: Context;
    summary?: string;
    usage: Usage;
}

export async function requestProviderCompaction(options: {
    provider: Provider;
    model: Model;
    context: Context;
    signal?: AbortSignal;
    now: () => number;
}): Promise<ProviderCompaction> {
    if (options.provider.compact === undefined) {
        throw new Error(
            `Provider '${options.provider.id}' does not support conversation compaction.`,
        );
    }
    const result = await options.provider.compact({
        context: options.context,
        model: options.model,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.status === "cancelled") {
        throw new Error("Conversation compaction was stopped.");
    }
    if (result.status === "failed") throw new Error(result.message);
    return {
        context: result.context,
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        usage: requireCompactionUsage(result.usage),
    };
}

function requireCompactionUsage(
    usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"> | undefined,
): Usage {
    if (usage === undefined) {
        throw new Error("The provider completed compaction without reporting token usage.");
    }
    return {
        ...usage,
        cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            total: 0,
        },
    };
}
