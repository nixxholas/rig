import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { presenceContextSchema, type PresenceEvent } from "./PresenceEvent.js";
import {
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import { presenceStateSchema, type PresenceState } from "./PresenceState.js";

export const presenceStoreSchema = Type.Unknown();
export const presenceScheduleStoreSchema = Type.Unknown();

export type PresenceStore = import("./PresenceDatabase.js").PresenceDatabase;

export const presenceReaderSchema = Type.Object(
    {
        read: Type.Function(
            [presenceContextSchema],
            Type.Promise(Type.Union([presenceStateSchema, Type.Undefined()])),
        ),
    },
    { additionalProperties: false },
);

export type PresenceReader = Static<typeof presenceReaderSchema>;
export type PresenceScheduleStore = PresenceStore["schedules"];

export function assertPresenceStateResult(value: unknown): asserts value is PresenceState {
    if (!Value.Check(presenceStateSchema, value)) {
        throw new Error("Presence database returned an invalid presence state.");
    }
}

export function assertPresenceScheduleResult(value: unknown): asserts value is PresenceSchedule {
    if (!Value.Check(presenceScheduleSchema, value)) {
        throw new Error("Presence database returned an invalid presence schedule.");
    }
}

export function assertPresenceContext(value: unknown): asserts value is Context {
    if (!Value.Check(presenceContextSchema, value)) {
        throw new Error("Presence context is invalid.");
    }
}

export type { PresenceEvent, PresenceSchedule, PresenceScheduleInput, PresenceState };
