import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    userInputAgentIdSchema,
    userInputListQuerySchema,
    userInputPageSchema,
    userInputPresenceStateSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputTimestampSchema,
    userInputTerminalRequestSchema,
    type UserInputPage,
} from "./UserInputRequest.js";
import { userInputContextSchema } from "./UserInputEvent.js";

const voidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
const userInputPresenceChangeCallbackSchema = Type.Function(
    [userInputContextSchema, Type.Union([userInputPresenceStateSchema, Type.Undefined()])],
    voidOrPromiseVoidSchema,
);
const userInputPresenceUnsubscribeSchema = Type.Function([], Type.Void());

/** Presence policy is structural; UserInputModule never imports or understands PresenceModule. */
export const userInputPresencePolicySchema = Type.Object(
    {
        isAvailable: Type.Optional(
            Type.Function(
                [userInputContextSchema, userInputAgentIdSchema],
                Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
            ),
        ),
        state: Type.Optional(
            Type.Function(
                [userInputContextSchema, userInputAgentIdSchema],
                Type.Union([
                    userInputPresenceStateSchema,
                    Type.Undefined(),
                    Type.Promise(Type.Union([userInputPresenceStateSchema, Type.Undefined()])),
                ]),
            ),
        ),
        subscribe: Type.Optional(
            Type.Function(
                [
                    userInputContextSchema,
                    userInputAgentIdSchema,
                    userInputPresenceChangeCallbackSchema,
                ],
                Type.Union([
                    Type.Void(),
                    userInputPresenceUnsubscribeSchema,
                    Type.Promise(Type.Union([Type.Void(), userInputPresenceUnsubscribeSchema])),
                ]),
            ),
        ),
        onChange: Type.Optional(
            Type.Function(
                [
                    userInputContextSchema,
                    userInputAgentIdSchema,
                    userInputPresenceChangeCallbackSchema,
                ],
                Type.Union([
                    Type.Void(),
                    userInputPresenceUnsubscribeSchema,
                    Type.Promise(Type.Union([Type.Void(), userInputPresenceUnsubscribeSchema])),
                ]),
            ),
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
export const userInputBrokerWaitOptionsSchema = Type.Object(
    {
        timeoutAt: Type.Optional(userInputTimestampSchema),
    },
    { additionalProperties: false },
);

export const userInputBrokerSchema = Type.Object(
    {
        wait: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputRequestIdSchema,
                Type.Optional(userInputBrokerWaitOptionsSchema),
            ],
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
