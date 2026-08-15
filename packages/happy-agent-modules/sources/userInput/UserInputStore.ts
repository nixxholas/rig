import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    userInputAgentIdSchema,
    userInputListQuerySchema,
    userInputPageSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputTerminalRequestSchema,
    type UserInputPage,
} from "./UserInputRequest.js";
import { userInputContextSchema } from "./UserInputEvent.js";

/**
 * The presence policy is intentionally structural. UserInputModule does not import or
 * understand PresenceModule; the host decides whether the human is currently reachable.
 */
export const userInputPresencePolicySchema = Type.Object(
    {
        isAvailable: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema],
            Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
        ),
    },
    { additionalProperties: false },
);

export const userInputAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("wait"),
    Type.Literal("answer"),
    Type.Literal("cancel"),
    Type.Literal("complete"),
]);

export const userInputAuthorizationSchema = Type.Object(
    {
        authorize: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputAgentIdSchema,
                userInputAuthorizationActionSchema,
            ],
            Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
        ),
    },
    { additionalProperties: false },
);

/** Narrow view of the internal storage contract; long waits are delegated to UserInputBroker. */
export const userInputBrokerSchema = Type.Object(
    {
        wait: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema, userInputRequestIdSchema],
            Type.Promise(userInputTerminalRequestSchema),
        ),
    },
    { additionalProperties: false },
);

/** Internal SQL adapter contract used by UserInputModule's module-owned tables. */
export const userInputStoreSchema = Type.Object(
    {
        readRequest: Type.Function(
            [userInputContextSchema, userInputRequestIdSchema],
            Type.Promise(Type.Union([userInputRequestSchema, Type.Undefined()])),
        ),
        writeRequest: Type.Function(
            [userInputContextSchema, userInputRequestSchema],
            Type.Promise(Type.Void()),
        ),
        listRequests: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema, userInputListQuerySchema],
            Type.Promise(userInputPageSchema),
        ),
    },
    { additionalProperties: false },
);

export type UserInputPresencePolicy = Static<typeof userInputPresencePolicySchema>;
export type UserInputAuthorizationAction = Static<typeof userInputAuthorizationActionSchema>;
export type UserInputAuthorization = Static<typeof userInputAuthorizationSchema>;
export type UserInputBroker = Static<typeof userInputBrokerSchema>;
export type UserInputStore = Static<typeof userInputStoreSchema>;

export function assertUserInputPage(value: unknown): asserts value is UserInputPage {
    if (!Value.Check(userInputPageSchema, value)) {
        throw new Error("User input store returned an invalid request page.");
    }
}

export function assertUserInputVoidResult(value: unknown, operation: string): void {
    if (value !== undefined) {
        throw new Error(`User input ${operation} must return undefined.`);
    }
}

export function assertUserInputContext(value: unknown): asserts value is Context {
    if (!Value.Check(userInputContextSchema, value)) {
        throw new Error("User input context is invalid.");
    }
}
