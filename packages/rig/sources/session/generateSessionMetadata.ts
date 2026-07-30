import type { Model, Provider, StreamOptions } from "@slopus/rig-execution";
import { providerModelFamily } from "@slopus/rig-providers";
import { toLocalDate } from "../executor/toLocalDate.js";

const METADATA_PROMPT = `Create concise session metadata from the visible conversation.

Return exactly one JSON object with exactly these string fields:
{"title":"...","recap":"..."}

Rules:
- title is 2 to 6 words and at most 80 characters
- recap is at most 2 sentences and 600 characters
- recap states the user's goal and the useful outcome or current state
- preserve the current title exactly unless the conversation clearly makes it misleading
- use only the supplied visible conversation; do not infer from hidden tool calls or reasoning
- return strict JSON with no markdown or commentary`;

export interface GeneratedSessionMetadata {
    recap: string;
    title: string;
}

export async function generateSessionMetadata(options: {
    currentTitle?: string;
    /** Model the session itself is running, which decides what may name it. */
    modelId: string;
    now?: () => number;
    provider: Provider;
    sessionId: string;
    signal?: AbortSignal;
    startDate?: string;
    transcript: string;
}): Promise<GeneratedSessionMetadata> {
    const now = options.now ?? Date.now;
    const timestamp = now();
    const model = selectMetadataModel(options.provider, options.modelId);
    // Naming a chat is its own one-shot conversation, not a turn of the session's. It runs on its
    // own provider session so it cannot reset the session's cached prefix or wait behind its turn.
    const provider = options.provider.isolate?.("title") ?? options.provider;
    const streamOptions: StreamOptions = {
        sessionId: `${options.sessionId}:title`,
        startDate: options.startDate ?? toLocalDate(timestamp),
        thinking: "off",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    try {
        const stream = provider.stream(
            model,
            {
                systemPrompt: METADATA_PROMPT,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: [
                                    `Current title: ${options.currentTitle ?? "(untitled)"}`,
                                    "",
                                    "Visible conversation:",
                                    options.transcript,
                                ].join("\n"),
                            },
                        ],
                        timestamp,
                    },
                ],
                tools: [],
            },
            streamOptions,
        );
        for await (const _event of stream) {
            // Drain the stream; the normalized final message is read below.
        }

        const message = await stream.result();
        const text = message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("")
            .trim();
        return parseSessionMetadata(text);
    } finally {
        // The isolated provider exists only for this one request.
        if (provider !== options.provider) await provider.close?.();
    }
}

export function parseSessionMetadata(text: string): GeneratedSessionMetadata {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Session metadata model returned invalid JSON.");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Session metadata model did not return an object.");
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== "recap,title" ||
        typeof record.title !== "string" ||
        typeof record.recap !== "string"
    ) {
        throw new Error("Session metadata must contain only string title and recap fields.");
    }

    const title = normalizeLine(record.title);
    const titleWords = title.split(/\s+/u).filter(Boolean);
    if (title.length > 80 || titleWords.length < 2 || titleWords.length > 6) {
        throw new Error("Session metadata title must contain 2 to 6 words.");
    }

    const recap = normalizeLine(record.recap);
    const sentences = recap.split(/(?<=[.!?])\s+/u).filter(Boolean);
    if (recap.length === 0 || recap.length > 600 || sentences.length > 2) {
        throw new Error(
            "Session metadata recap must contain at most 2 sentences and 600 characters.",
        );
    }
    return { recap, title };
}

function normalizeLine(value: string): string {
    return value
        .replace(/[\r\n\t]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

/** Inexpensive models worth naming a chat with, one per family. */
const ECONOMICAL_MODEL_IDS = [
    "anthropic/sonnet-5",
    "openai/gpt-5.6-sol",
    "xai/grok-composer-2.5-fast",
];

/**
 * Picks what writes the title, starting from the model the session is already running.
 *
 * Writing two sentences deserves the cheapest model available, but not at the cost of leaving the
 * session's own family: a provider cannot serve a model from another family, so reaching for one
 * fails outright. The session's model is therefore both the starting point and the fallback.
 */
function selectMetadataModel(provider: Provider, sessionModelId: string): Model {
    const sessionModel = provider.models.find((model) => model.id === sessionModelId);
    if (sessionModel === undefined) {
        throw new Error(
            `Model '${sessionModelId}' is unavailable on '${provider.id}' for session metadata.`,
        );
    }
    const family = providerModelFamily(sessionModelId);
    const economical = provider.models.find(
        (model) =>
            ECONOMICAL_MODEL_IDS.includes(model.id) && providerModelFamily(model.id) === family,
    );
    return economical ?? sessionModel;
}
