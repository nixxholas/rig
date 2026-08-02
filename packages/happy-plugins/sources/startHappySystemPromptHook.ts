import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    happySystemPromptHookCompletionSchema,
    happySystemPromptHookEventSchema,
    happySystemPromptHookResultSchema,
    type HappySystemPromptHook,
    type HappySystemPromptHookInput,
    type HappySystemPromptHookResult,
} from "./types.js";
import type { HappyMcpTransport } from "./startHappyMcpServer.js";
import { startHappyPluginEventRegistration } from "./startHappyPluginEventRegistration.js";

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

export async function startHappySystemPromptHook(
    handler: (
        input: HappySystemPromptHookInput,
    ) => HappySystemPromptHookResult | Promise<HappySystemPromptHookResult>,
    transport: HappyMcpTransport,
): Promise<HappySystemPromptHook> {
    const registration = await startHappyPluginEventRegistration({
        deletePath: (registrationId) =>
            `/hooks/system-prompt/${encodeURIComponent(registrationId)}`,
        eventPath: (registrationId) =>
            `/hooks/system-prompt/${encodeURIComponent(registrationId)}/events`,
        eventSchema: happySystemPromptHookEventSchema,
        label: "system-prompt hook",
        onEvent(event, registrationId) {
            return Promise.resolve()
                .then(() => handler(event.input))
                .then((result) => Value.Decode(happySystemPromptHookResultSchema, result))
                .then((result) =>
                    transport.request(
                        "POST",
                        `/hooks/system-prompt/${encodeURIComponent(registrationId)}/calls/${encodeURIComponent(event.callId)}`,
                        emptyResponseSchema,
                        Value.Decode(happySystemPromptHookCompletionSchema, { result }),
                    ),
                )
                .then(() => undefined)
                .catch((error: unknown) => {
                    warn(`The Happy system-prompt hook failed. ${errorToMessage(error)}`);
                });
        },
        registerPath: "/hooks/system-prompt",
        transport,
    });
    return {
        get failure() {
            return registration.failure;
        },
        get registrationId() {
            return registration.registrationId;
        },
        get status() {
            return registration.status;
        },
        close: () => registration.close(),
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Plugin logging is diagnostic and cannot fail a hook.
    }
}
