import { Type, type Static } from "@sinclair/typebox";

export const geminiSearchInputSchema = Type.Object(
    {
        query: Type.String({ minLength: 2, description: "The query Gemini should search for" }),
        allowed_domains: Type.Optional(
            Type.Array(Type.String(), {
                description: "Only use sources from these domains",
            }),
        ),
        blocked_domains: Type.Optional(
            Type.Array(Type.String(), {
                description: "Exclude sources from these domains",
            }),
        ),
    },
    { additionalProperties: false },
);

export const geminiSearchSourceSchema = Type.Object({
    title: Type.String(),
    url: Type.String(),
});

export const geminiSearchOutputSchema = Type.Object({
    query: Type.String(),
    answer: Type.String(),
    sources: Type.Array(geminiSearchSourceSchema),
    durationSeconds: Type.Number(),
});

export type GeminiSearchInput = Static<typeof geminiSearchInputSchema>;
export type GeminiSearchSource = Static<typeof geminiSearchSourceSchema>;
export type GeminiSearchOutput = Static<typeof geminiSearchOutputSchema>;
