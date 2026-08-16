import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { presenceContextSchema } from "./PresenceEvent.js";
import { presenceUserInputStateSchema, type PresenceUserInputState } from "./PresenceState.js";

export const presenceAgentIdSchema = Type.String({ minLength: 1, maxLength: 128 });

const voidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
const presenceUserInputChangeStateSchema = Type.Union([
    presenceUserInputStateSchema,
    Type.Undefined(),
]);

export const presenceUserInputChangeCallbackSchema = Type.Function(
    [presenceContextSchema, presenceUserInputChangeStateSchema],
    voidOrPromiseVoidSchema,
);

const unsubscribeSchema = Type.Function([], Type.Void());
const stateResultSchema = Type.Union([
    presenceUserInputStateSchema,
    Type.Undefined(),
    Type.Promise(presenceUserInputChangeStateSchema),
]);
const subscribeResultSchema = Type.Union([
    Type.Void(),
    unsubscribeSchema,
    Type.Promise(Type.Union([Type.Void(), unsubscribeSchema])),
]);

/**
 * Structural seam for UserInputModule. Presence is shared by all agents, so the agent ID is
 * accepted for composition and intentionally does not affect the returned state.
 */
export const presenceUserInputPolicySchema = Type.Object(
    {
        state: Type.Function([presenceContextSchema, presenceAgentIdSchema], stateResultSchema),
        subscribe: Type.Function(
            [presenceContextSchema, presenceAgentIdSchema, presenceUserInputChangeCallbackSchema],
            subscribeResultSchema,
        ),
    },
    { additionalProperties: false },
);

export type PresenceUserInputChangeCallback = Static<typeof presenceUserInputChangeCallbackSchema>;
export type PresenceUserInputPolicy = Static<typeof presenceUserInputPolicySchema>;

export function assertPresenceUserInputPolicy(
    value: unknown,
): asserts value is PresenceUserInputPolicy {
    if (!Value.Check(presenceUserInputPolicySchema, value)) {
        throw new Error("Presence user-input policy is invalid.");
    }
}

export function assertPresenceUserInputResult(
    value: unknown,
): asserts value is PresenceUserInputState | undefined {
    if (!Value.Check(presenceUserInputChangeStateSchema, value)) {
        throw new Error("Presence user-input state result is invalid.");
    }
}
