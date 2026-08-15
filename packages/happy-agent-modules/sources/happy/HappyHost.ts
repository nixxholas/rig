import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    happyAgentIdSchema,
    happyDeliveryResultSchema,
    happyNotificationSchema,
    happyStatusRecordSchema,
} from "./Happy.js";

const contextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

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

function materialize(value: HappyHost): HappyHost {
    return {
        notify: value.notify,
        setStatus: value.setStatus,
    };
}

export function assertHappyHost(value: unknown): asserts value is HappyHost {
    const candidate = value as Record<string, unknown>;
    const materialized = {
        notify: candidate?.notify,
        setStatus: candidate?.setStatus,
    };
    if (!Value.Check(happyHostSchema, materialized)) {
        throw new Error("Happy module host is invalid.");
    }
}

export function checkedHappyHost(value: HappyHost): HappyHost {
    const host = materialize(value);
    assertHappyHost(host);
    return host;
}