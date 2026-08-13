import { Type, type Static } from "@sinclair/typebox";

/** Who a recorded message came from. The four roles a reader may filter on. */
export const historyRoleSchema = Type.Union([
    Type.Literal("assistant"),
    Type.Literal("error"),
    Type.Literal("system"),
    Type.Literal("user"),
]);

/** The TypeScript type inferred from {@link historyRoleSchema}. */
export type HistoryRole = Static<typeof historyRoleSchema>;

/** Something said, by anyone. */
export const historyTextBlockSchema = Type.Object({
    type: Type.Literal("text"),
    text: Type.String(),
});

/** Reasoning the model exposed, or the fact that it kept it to itself. */
export const historyThinkingBlockSchema = Type.Object({
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    /** The provider hid the reasoning itself, so only its existence was recorded. */
    redacted: Type.Optional(Type.Boolean()),
});

/** An image, kept as its kind alone: history is read as text. */
export const historyImageBlockSchema = Type.Object({
    type: Type.Literal("image"),
    mediaType: Type.String(),
});

/** A tool the model asked for, with the arguments it asked with. */
export const historyToolCallBlockSchema = Type.Object({
    type: Type.Literal("tool_call"),
    callId: Type.String(),
    name: Type.String(),
    arguments: Type.Unknown(),
});

/** What a tool answered, summarized and already bounded by whoever recorded it. */
export const historyToolResultBlockSchema = Type.Object({
    type: Type.Literal("tool_result"),
    callId: Type.String(),
    toolName: Type.String(),
    /** The one-line summary a person would have seen. */
    display: Type.Optional(Type.String()),
    /** What the model was shown, as text. */
    output: Type.String(),
    isError: Type.Optional(Type.Boolean()),
});

/** One piece of a recorded message. */
export const historyBlockSchema = Type.Union([
    historyTextBlockSchema,
    historyThinkingBlockSchema,
    historyImageBlockSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
]);

/** The TypeScript type inferred from {@link historyBlockSchema}. */
export type HistoryBlock = Static<typeof historyBlockSchema>;

/**
 * One message of an agent's durable history.
 *
 * It is not the provider's context and cannot be replayed as one: images are named rather than
 * carried, hidden reasoning is absent, and tool output is whatever the recorder kept. It is the
 * record of what happened, for a reader — a person, or a model that has lost the conversation.
 */
export const historyMessageSchema = Type.Object({
    role: historyRoleSchema,
    blocks: Type.Array(historyBlockSchema),
    /** When it was recorded, in epoch milliseconds. */
    at: Type.Optional(Type.Integer()),
    /** The registry ID of the provider that produced it, for an inference. */
    provider: Type.Optional(Type.String()),
    /** The model that produced it, for an inference. */
    model: Type.Optional(Type.String()),
});

/** The TypeScript type inferred from {@link historyMessageSchema}. */
export type HistoryMessage = Static<typeof historyMessageSchema>;
