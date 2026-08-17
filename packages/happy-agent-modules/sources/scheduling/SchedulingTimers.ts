import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The longest delay a host timer is asked for at once; longer waits are re-armed in chunks. */
const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * The timers scheduling runs on. Scheduling owns its alarms rather than asking a host to keep them,
 * so this contract exists to make time controllable in a test, not to hand the capability away.
 */
export const schedulingTimersSchema = Type.Object(
    {
        start: Type.Function([Type.Number(), Type.Function([], Type.Void())], Type.Unknown()),
        stop: Type.Function([Type.Unknown()], Type.Void()),
    },
    { additionalProperties: false },
);

export type SchedulingTimers = Static<typeof schedulingTimersSchema>;

/** Node timers, unreferenced so a pending scheduled message never keeps the process alive alone. */
export const nodeSchedulingTimers: SchedulingTimers = {
    start: (delay: number, fire: () => void): unknown => {
        const handle = setTimeout(fire, delay);
        (handle as { unref?: () => void }).unref?.();
        return handle;
    },
    stop: (handle: unknown): void => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

export function assertSchedulingTimers(value: unknown): asserts value is SchedulingTimers {
    if (!Value.Check(schedulingTimersSchema, value)) {
        throw new Error("Scheduling module received invalid timers.");
    }
}

/**
 * One alarm that fires at an absolute time.
 *
 * A due time may be further away than a single host timer can express, so the alarm re-arms itself
 * in chunks and only fires once the clock has actually reached the moment asked for. Cancelling is
 * idempotent, and an alarm that already fired cannot fire again.
 */
export class SchedulingAlarm {
    readonly #timers: SchedulingTimers;
    readonly #now: () => number;
    #handle: unknown;
    #done = false;

    constructor(timers: SchedulingTimers, now: () => number, dueAt: number, fire: () => void) {
        this.#timers = timers;
        this.#now = now;
        this.#arm(dueAt, fire);
    }

    cancel(): void {
        if (this.#done) return;
        this.#done = true;
        if (this.#handle !== undefined) this.#timers.stop(this.#handle);
        this.#handle = undefined;
    }

    #arm(dueAt: number, fire: () => void): void {
        if (this.#done) return;
        const remaining = dueAt - this.#now();
        if (remaining <= 0) {
            this.#done = true;
            this.#handle = undefined;
            fire();
            return;
        }
        this.#handle = this.#timers.start(Math.min(remaining, MAX_TIMER_DELAY), () => {
            this.#handle = undefined;
            this.#arm(dueAt, fire);
        });
    }
}
