import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    happyAgentIdSchema,
    happyDeliveryResultSchema,
    happyNotificationSchema,
    happyStatusRecordSchema,
} from "./Happy.js";

const contextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false }));

export const happyHostSchema = Type.Object(
    {
        notify: Type.Function(
            [contextSchema, happyAgentIdSchema, happyNotificationSchema],
            Type.Promise(happyDeliveryResultSchema),
        ),
        setStatus: Type.Function(
            [contextSchema, happyAgentIdSchema, happyStatusRecordSchema],
            Type.Promise(happyDeliveryResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type HappyHost = Static<typeof happyHostSchema>;

/**
 * The value a host is checked as. A plain object is the transport boundary itself, so it must
 * carry exactly `notify` and `setStatus` and nothing more. An adapter instance keeps its own state
 * beside those methods, so only the boundary it exposes is checked.
 */
export function happyHostShape(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === Object.prototype || prototype === null) return value;
    const adapter = value as Partial<HappyHost>;
    return { notify: adapter.notify, setStatus: adapter.setStatus };
}

export function assertHappyHost(value: unknown): asserts value is HappyHost {
    if (!Value.Check(happyHostSchema, happyHostShape(value))) {
        throw new Error("Happy module host is invalid.");
    }
}

/**
 * The host as the module calls it. Every call goes back through the object that supplied the
 * method, so a class-backed adapter keeps its own receiver and its own state.
 */
export function checkedHappyHost(value: HappyHost): HappyHost {
    assertHappyHost(value);
    return {
        notify: async (ctx, agentId, notification) =>
            await value.notify(ctx, agentId, notification),
        setStatus: async (ctx, agentId, status) => await value.setStatus(ctx, agentId, status),
    };
}
