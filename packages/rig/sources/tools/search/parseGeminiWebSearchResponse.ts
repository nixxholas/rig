import type { GeminiSearchOutput, GeminiSearchSource } from "../search/GeminiWebSearchTypes.js";

interface GeminiTextBlock {
    annotations?: readonly {
        title?: string;
        type?: string;
        url?: string;
    }[];
    text?: string;
    type?: string;
}

interface GeminiInteractionResponse {
    steps?: readonly {
        content?: readonly GeminiTextBlock[];
        type?: string;
    }[];
}

export function parseGeminiWebSearchResponse(
    response: unknown,
    query: string,
    durationSeconds: number,
): GeminiSearchOutput {
    const interaction =
        typeof response === "object" && response !== null
            ? (response as GeminiInteractionResponse)
            : {};
    const hits = new Map<string, GeminiSearchSource>();
    const text: string[] = [];

    for (const step of interaction.steps ?? []) {
        if (step.type !== "model_output") continue;
        for (const block of step.content ?? []) {
            if (block.type !== "text") continue;
            if (block.text?.trim()) text.push(block.text.trim());
            for (const annotation of block.annotations ?? []) {
                if (annotation.type !== "url_citation" || !annotation.url) continue;
                hits.set(annotation.url, {
                    title: annotation.title?.trim() || annotation.url,
                    url: annotation.url,
                });
            }
        }
    }

    if (text.length === 0) {
        throw new Error("Gemini web search returned no text response.");
    }

    return {
        answer: text.join("\n\n"),
        durationSeconds,
        query,
        sources: [...hits.values()],
    };
}
