import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES,
    HAPPY_COMPUTE_MAX_FILE_BYTES,
    happyComputeCallCompletionSchema,
    happyComputeEventSchema,
    type HappyComputeCallCompletion,
    type HappyComputeCallEvent,
    type HappyComputeProviderHandlers,
    type HappyComputeRegistration,
} from "./computeTypes.js";
import { startHappyPluginEventRegistration } from "./startHappyPluginEventRegistration.js";
import type { HappyMcpTransport } from "./startHappyMcpServer.js";

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });
const providerExecResultSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderr: Type.String(),
        stderrTruncated: Type.Boolean(),
        stdout: Type.String(),
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    { additionalProperties: false },
);
type ProviderExecResult = Static<typeof providerExecResultSchema>;

export async function startHappyComputeProvider(
    handlers: HappyComputeProviderHandlers,
    transport: HappyMcpTransport,
): Promise<HappyComputeRegistration> {
    const calls = new Map<string, AbortController>();
    const registration = await startHappyPluginEventRegistration({
        deletePath: (registrationId) => `/compute/providers/${encodeURIComponent(registrationId)}`,
        eventPath: (registrationId) =>
            `/compute/providers/${encodeURIComponent(registrationId)}/events`,
        eventSchema: happyComputeEventSchema,
        label: "compute provider",
        onEvent(event, registrationId) {
            if (event.type === "cancel") {
                calls.get(event.callId)?.abort();
                return;
            }
            const controller = new AbortController();
            calls.get(event.callId)?.abort();
            calls.set(event.callId, controller);
            void executeComputeCall(event, handlers, controller.signal)
                .then((completion) =>
                    transport.request(
                        "POST",
                        `/compute/providers/${encodeURIComponent(registrationId)}/calls/${encodeURIComponent(event.callId)}`,
                        emptyResponseSchema,
                        completion,
                    ),
                )
                .catch((error: unknown) => {
                    warn(`The Happy compute provider call failed. ${errorToMessage(error)}`);
                })
                .finally(() => {
                    if (calls.get(event.callId) === controller) calls.delete(event.callId);
                });
        },
        onGenerationClosed() {
            for (const controller of calls.values()) controller.abort();
            calls.clear();
        },
        recover: false,
        registerPath: "/compute/providers",
        transport,
    });
    let closeTask: Promise<void> | undefined;
    return {
        get failure() {
            return registration.failure;
        },
        get registrationId() {
            return registration.registrationId;
        },
        get status() {
            return registration.status === "reconnecting" ? "closed" : registration.status;
        },
        close() {
            return (closeTask ??= registration.close().finally(() => {
                for (const controller of calls.values()) controller.abort();
                calls.clear();
            }));
        },
    };
}

async function executeComputeCall(
    event: HappyComputeCallEvent,
    handlers: HappyComputeProviderHandlers,
    signal: AbortSignal,
): Promise<HappyComputeCallCompletion> {
    try {
        const context = { signal };
        let completion: HappyComputeCallCompletion;
        switch (event.operation) {
            case "start":
                completion = {
                    operation: "start",
                    result: {
                        instanceId: await handlers.start(
                            { workspaceSource: event.workspaceSource },
                            context,
                        ),
                    },
                };
                break;
            case "read": {
                const bytes = Buffer.from(
                    await handlers.read(
                        { instanceId: event.instanceId, path: event.path },
                        context,
                    ),
                );
                if (bytes.byteLength > HAPPY_COMPUTE_MAX_FILE_BYTES) {
                    throw new Error(
                        `Compute file reads cannot exceed ${String(HAPPY_COMPUTE_MAX_FILE_BYTES)} bytes.`,
                    );
                }
                completion = {
                    operation: "read",
                    result: {
                        bytes: bytes.byteLength,
                        contentBase64: bytes.toString("base64"),
                    },
                };
                break;
            }
            case "write":
                await handlers.write(
                    {
                        bytes: Buffer.from(event.contentBase64, "base64"),
                        instanceId: event.instanceId,
                        path: event.path,
                    },
                    context,
                );
                completion = { operation: "write", result: {} };
                break;
            case "exec": {
                const result = Value.Decode(
                    providerExecResultSchema,
                    await handlers.exec(
                        {
                            command: event.command,
                            instanceId: event.instanceId,
                            timeoutMs: event.timeoutMs,
                        },
                        context,
                    ),
                );
                const stdout = truncateUtf8(result.stdout);
                const stderr = truncateUtf8(result.stderr);
                completion = {
                    operation: "exec",
                    result: {
                        exitCode: result.exitCode,
                        stderrBase64: stderr.bytes.toString("base64"),
                        stderrTruncated: result.stderrTruncated || stderr.truncated,
                        stdoutBase64: stdout.bytes.toString("base64"),
                        stdoutTruncated: result.stdoutTruncated || stdout.truncated,
                        timedOut: result.timedOut,
                    },
                };
                break;
            }
            case "stop":
                await handlers.stop({ instanceId: event.instanceId }, context);
                completion = { operation: "stop", result: {} };
                break;
        }
        return Value.Decode(happyComputeCallCompletionSchema, completion);
    } catch (error) {
        return Value.Decode(happyComputeCallCompletionSchema, {
            error: errorToMessage(error),
        });
    }
}

function truncateUtf8(value: ProviderExecResult["stdout"]): {
    bytes: Buffer;
    truncated: boolean;
} {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.byteLength <= HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES) {
        return { bytes: encoded, truncated: false };
    }
    let text = encoded.subarray(0, HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES).toString("utf8");
    while (Buffer.byteLength(text, "utf8") > HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES) {
        text = text.slice(0, -1);
    }
    return { bytes: Buffer.from(text, "utf8"), truncated: true };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Provider diagnostics cannot fail the plugin process.
    }
}
