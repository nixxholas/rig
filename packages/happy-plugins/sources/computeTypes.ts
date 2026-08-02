import { type Static, Type } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });
const instanceIdSchema = Type.String({ maxLength: 128, minLength: 1 });

export const HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const HAPPY_COMPUTE_MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const HAPPY_COMPUTE_MAX_FILE_BYTES = 1024 * 1024;

export const happyComputeProviderNameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
});
export type HappyComputeProviderName = Static<typeof happyComputeProviderNameSchema>;

export const happyComputeProviderManifestSchema = Type.Object(
    { name: happyComputeProviderNameSchema },
    exact,
);
export type HappyComputeProviderManifest = Static<typeof happyComputeProviderManifestSchema>;

export const happyComputeProviderHealthSchema = Type.Union([
    Type.Literal("healthy"),
    Type.Literal("degraded"),
    Type.Literal("failed"),
]);
export type HappyComputeProviderHealth = Static<typeof happyComputeProviderHealthSchema>;

export const happyComputeProviderContributionSchema = Type.Object(
    {
        health: happyComputeProviderHealthSchema,
        name: happyComputeProviderNameSchema,
    },
    exact,
);
export type HappyComputeProviderContribution = Static<
    typeof happyComputeProviderContributionSchema
>;

export const happyComputeProviderSchema = Type.Object(
    {
        health: happyComputeProviderHealthSchema,
        name: happyComputeProviderNameSchema,
        pluginFolder: Type.String({ maxLength: 255, minLength: 1 }),
        pluginName: nonEmptyText,
    },
    exact,
);
export type HappyComputeProvider = Static<typeof happyComputeProviderSchema>;

export const happyComputeWorkspaceSourceSchema = Type.Union([
    Type.Object(
        {
            path: Type.String({ maxLength: 4_096, minLength: 1 }),
            type: Type.Literal("local_directory"),
        },
        exact,
    ),
]);
export type HappyComputeWorkspaceSource = Static<typeof happyComputeWorkspaceSourceSchema>;

export const happyComputeRelativePathSchema = Type.String({
    maxLength: 4_096,
    minLength: 1,
    pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\).+$",
});

export const startHappyComputeInputSchema = Type.Object(
    {
        provider: happyComputeProviderNameSchema,
        workspaceSource: happyComputeWorkspaceSourceSchema,
    },
    exact,
);
export type StartHappyComputeInput = Static<typeof startHappyComputeInputSchema>;
export const startHappyComputeHandlerInputSchema = Type.Pick(startHappyComputeInputSchema, [
    "workspaceSource",
]);
export type StartHappyComputeHandlerInput = Static<typeof startHappyComputeHandlerInputSchema>;

export const happyComputeInstanceSchema = Type.Object(
    {
        instanceId: instanceIdSchema,
        provider: happyComputeProviderNameSchema,
    },
    exact,
);
export type HappyComputeInstance = Static<typeof happyComputeInstanceSchema>;

export const readHappyComputeInputSchema = Type.Object(
    {
        instanceId: instanceIdSchema,
        path: happyComputeRelativePathSchema,
    },
    exact,
);
export type ReadHappyComputeInput = Static<typeof readHappyComputeInputSchema>;

export const writeHappyComputeInputSchema = Type.Object(
    {
        bytes: Type.Uint8Array({ maxByteLength: HAPPY_COMPUTE_MAX_FILE_BYTES }),
        instanceId: instanceIdSchema,
        path: happyComputeRelativePathSchema,
    },
    exact,
);
export type WriteHappyComputeInput = Static<typeof writeHappyComputeInputSchema>;

export const execHappyComputeInputSchema = Type.Object(
    {
        command: Type.String({ maxLength: 64 * 1024, minLength: 1 }),
        instanceId: instanceIdSchema,
        timeoutMs: Type.Optional(
            Type.Integer({
                default: HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
                maximum: HAPPY_COMPUTE_MAX_COMMAND_TIMEOUT_MS,
                minimum: 1,
            }),
        ),
    },
    exact,
);
export type ExecHappyComputeInput = Static<typeof execHappyComputeInputSchema>;
export const execHappyComputeHandlerInputSchema = Type.Required(execHappyComputeInputSchema);
export type ExecHappyComputeHandlerInput = Static<typeof execHappyComputeHandlerInputSchema>;

export const stopHappyComputeInputSchema = Type.Object({ instanceId: instanceIdSchema }, exact);
export type StopHappyComputeInput = Static<typeof stopHappyComputeInputSchema>;

export const happyComputeExecResultSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderr: Type.String({ maxLength: HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES }),
        stderrTruncated: Type.Boolean(),
        stdout: Type.String({ maxLength: HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES }),
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export type HappyComputeExecResult = Static<typeof happyComputeExecResultSchema>;

const fileBytesBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_COMPUTE_MAX_FILE_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});
const outputBytesBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const listHappyComputeProvidersResponseSchema = Type.Object(
    { providers: Type.Array(happyComputeProviderSchema, { maxItems: 64 }) },
    exact,
);
export const startHappyComputeBodySchema = startHappyComputeInputSchema;
export const startHappyComputeResponseSchema = happyComputeInstanceSchema;
export const readHappyComputeBodySchema = Type.Pick(readHappyComputeInputSchema, ["path"]);
export const readHappyComputeResponseSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: HAPPY_COMPUTE_MAX_FILE_BYTES, minimum: 0 }),
        contentBase64: fileBytesBase64Schema,
    },
    exact,
);
export const writeHappyComputeBodySchema = Type.Object(
    { contentBase64: fileBytesBase64Schema, path: happyComputeRelativePathSchema },
    exact,
);
export const execHappyComputeBodySchema = Type.Omit(execHappyComputeInputSchema, ["instanceId"]);
export const execHappyComputeResponseSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderrBase64: outputBytesBase64Schema,
        stderrTruncated: Type.Boolean(),
        stdoutBase64: outputBytesBase64Schema,
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export const emptyHappyComputeResponseSchema = Type.Object({}, exact);

const computeCallBase = {
    callId: nonEmptyText,
    type: Type.Literal("call"),
};
export const happyComputeCallEventSchema = Type.Union([
    Type.Object(
        {
            ...computeCallBase,
            operation: Type.Literal("start"),
            workspaceSource: happyComputeWorkspaceSourceSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            instanceId: instanceIdSchema,
            operation: Type.Literal("read"),
            path: happyComputeRelativePathSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            contentBase64: fileBytesBase64Schema,
            instanceId: instanceIdSchema,
            operation: Type.Literal("write"),
            path: happyComputeRelativePathSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            command: Type.String({ maxLength: 64 * 1024, minLength: 1 }),
            instanceId: instanceIdSchema,
            operation: Type.Literal("exec"),
            timeoutMs: Type.Integer({
                maximum: HAPPY_COMPUTE_MAX_COMMAND_TIMEOUT_MS,
                minimum: 1,
            }),
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            instanceId: instanceIdSchema,
            operation: Type.Literal("stop"),
        },
        exact,
    ),
]);
export type HappyComputeCallEvent = Static<typeof happyComputeCallEventSchema>;

export const happyComputeCancelEventSchema = Type.Object(
    { callId: nonEmptyText, type: Type.Literal("cancel") },
    exact,
);
export const happyComputeEventSchema = Type.Union([
    happyComputeCallEventSchema,
    happyComputeCancelEventSchema,
]);
export type HappyComputeEvent = Static<typeof happyComputeEventSchema>;

export const happyComputeErrorCodeSchema = Type.Union([
    Type.Literal("capacity_exhausted"),
    Type.Literal("deadline_exceeded"),
    Type.Literal("invalid_request"),
    Type.Literal("invalid_response"),
    Type.Literal("instance_failed"),
    Type.Literal("instance_not_found"),
    Type.Literal("provider_lost"),
    Type.Literal("provider_not_found"),
    Type.Literal("provider_unhealthy"),
]);
export type HappyComputeErrorCode = Static<typeof happyComputeErrorCodeSchema>;

const nonRetryableComputeErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("invalid_response"),
    Type.Literal("instance_failed"),
    Type.Literal("instance_not_found"),
    Type.Literal("provider_lost"),
    Type.Literal("provider_not_found"),
    Type.Literal("provider_unhealthy"),
]);
export const happyComputeErrorSchema = Type.Union([
    Type.Object(
        {
            code: Type.Literal("capacity_exhausted"),
            message: nonEmptyText,
            retryable: Type.Literal(true),
        },
        exact,
    ),
    Type.Object(
        {
            code: Type.Literal("deadline_exceeded"),
            message: nonEmptyText,
            retryable: Type.Boolean(),
        },
        exact,
    ),
    Type.Object(
        {
            code: nonRetryableComputeErrorCodeSchema,
            message: nonEmptyText,
            retryable: Type.Literal(false),
        },
        exact,
    ),
]);
export type HappyComputeError = Static<typeof happyComputeErrorSchema>;

export const happyComputeCallCompletionSchema = Type.Union([
    Type.Object({ error: happyComputeErrorSchema }, exact),
    Type.Object(
        {
            operation: Type.Literal("start"),
            result: Type.Object({ instanceId: instanceIdSchema }, exact),
        },
        exact,
    ),
    Type.Object(
        {
            operation: Type.Literal("read"),
            result: Type.Object(
                {
                    bytes: Type.Integer({
                        maximum: HAPPY_COMPUTE_MAX_FILE_BYTES,
                        minimum: 0,
                    }),
                    contentBase64: fileBytesBase64Schema,
                },
                exact,
            ),
        },
        exact,
    ),
    Type.Object({ operation: Type.Literal("write"), result: Type.Object({}, exact) }, exact),
    Type.Object(
        {
            operation: Type.Literal("exec"),
            result: execHappyComputeResponseSchema,
        },
        exact,
    ),
    Type.Object({ operation: Type.Literal("stop"), result: Type.Object({}, exact) }, exact),
]);
export type HappyComputeCallCompletion = Static<typeof happyComputeCallCompletionSchema>;

export const registerHappyComputeProviderResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export interface HappyComputeHandlerContext {
    /** Aborted when the caller deadline expires or the provider generation is retired. */
    readonly signal: AbortSignal;
}

export interface HappyComputeProviderHandlers {
    exec(
        input: ExecHappyComputeHandlerInput,
        context: HappyComputeHandlerContext,
    ): HappyComputeExecResult | Promise<HappyComputeExecResult>;
    read(
        input: ReadHappyComputeInput,
        context: HappyComputeHandlerContext,
    ): Uint8Array | Promise<Uint8Array>;
    start(
        input: StartHappyComputeHandlerInput,
        context: HappyComputeHandlerContext,
    ): string | Promise<string>;
    stop(input: StopHappyComputeInput, context: HappyComputeHandlerContext): void | Promise<void>;
    write(input: WriteHappyComputeInput, context: HappyComputeHandlerContext): void | Promise<void>;
}

export interface HappyComputeRegistration {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: "closed" | "connected";
    close(): Promise<void>;
}
