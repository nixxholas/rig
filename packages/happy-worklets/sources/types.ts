import { Type, type Static, type TSchema } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });

export const workletTextContentSchema = Type.Object(
    { text: Type.String(), type: Type.Literal("text") },
    exact,
);

export const workletImageContentSchema = Type.Object(
    {
        data: Type.String(),
        mimeType: Type.String({ pattern: "^image/" }),
        type: Type.Literal("image"),
    },
    exact,
);

export const workletContentSchema = Type.Union([
    workletTextContentSchema,
    workletImageContentSchema,
]);

export type WorkletContent = Static<typeof workletContentSchema>;

export const workletToolResultSchema = Type.Object(
    {
        content: Type.Array(workletContentSchema, { maxItems: 128 }),
        isError: Type.Optional(Type.Boolean()),
        structuredContent: Type.Optional(Type.Unknown()),
    },
    exact,
);

export type WorkletToolResult = Static<typeof workletToolResultSchema>;

/** The JSON Schema subset accepted at the worklet socket boundary. */
export const workletInputSchemaSchema = Type.Object(
    {
        additionalProperties: Type.Optional(Type.Union([Type.Boolean(), Type.Unknown()])),
        properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        required: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
        type: Type.Literal("object"),
    },
    { additionalProperties: true },
);

export const workletToolRegistrationSchema = Type.Object(
    {
        description: Type.String(),
        inputSchema: workletInputSchemaSchema,
        name: Type.String({ maxLength: 64, minLength: 1, pattern: "^[A-Za-z0-9_-]+$" }),
    },
    exact,
);

export const registerWorkletToolsRequestSchema = Type.Object(
    { tools: Type.Array(workletToolRegistrationSchema, { maxItems: 64, minItems: 1 }) },
    exact,
);

export type RegisterWorkletToolsRequest = Static<typeof registerWorkletToolsRequestSchema>;

export const registerWorkletToolsResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export const workletCallEventSchema = Type.Object(
    {
        arguments: Type.Unknown(),
        callId: nonEmptyText,
        tool: nonEmptyText,
        type: Type.Literal("call"),
    },
    exact,
);

export const workletCancelEventSchema = Type.Object(
    { callId: nonEmptyText, type: Type.Literal("cancel") },
    exact,
);

export const workletEventSchema = Type.Union([workletCallEventSchema, workletCancelEventSchema]);

export type WorkletEvent = Static<typeof workletEventSchema>;

export const workletCallCompletionSchema = Type.Union([
    Type.Object({ result: workletToolResultSchema }, exact),
    Type.Object({ error: nonEmptyText }, exact),
]);

export type WorkletCallCompletion = Static<typeof workletCallCompletionSchema>;

export const workletStatusSchema = Type.String({ maxLength: 512 });

export const workletReadyRequestSchema = Type.Object(
    { status: Type.Optional(workletStatusSchema) },
    exact,
);

export const workletStatusRequestSchema = Type.Object({ status: workletStatusSchema }, exact);

export const emptyWorkletResponseSchema = Type.Object({}, exact);

export interface WorkletToolContext {
    /** Aborted when Rig cancels the model call, times it out, or retires this worklet. */
    readonly signal: AbortSignal;
}

export interface WorkletToolDefinition<TInputSchema extends TSchema = TSchema> {
    readonly description: string;
    readonly inputSchema: TInputSchema;
    readonly name: string;
    execute(
        input: Static<TInputSchema>,
        context: WorkletToolContext,
    ): WorkletToolResult | Promise<WorkletToolResult>;
}

export interface CreateWorkletClientOptions {
    socketPath?: string;
    token?: string;
}

export const createWorkletClientOptionsSchema = Type.Object(
    {
        socketPath: Type.Optional(nonEmptyText),
        token: Type.Optional(nonEmptyText),
    },
    exact,
);

export interface WorkletClient {
    /** The folder this worklet may write into. It survives every version change. */
    readonly data: string;
    readonly name: string;
    /** Declares the tools agents can call. Registration must finish before `ready`. */
    tools(tools: readonly WorkletToolDefinition[]): Promise<void>;
    /** Reports that startup finished, optionally with the worklet's first status line. */
    ready(status?: string): Promise<void>;
    /** The worklet's own words about itself, shown in the interface. */
    status(status: string): Promise<void>;
}
