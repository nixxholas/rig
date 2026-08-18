import { setTimeout as sleep } from "node:timers/promises";

export interface PublicSnapshot<State> {
    readonly state: State;
    readonly cursor?: string;
}

export interface PublicBarrierOptions {
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly signal?: AbortSignal;
}

export interface PublicStateBarrier<State> {
    readonly read: () => Promise<PublicSnapshot<State>>;
    readonly waitFor: (
        predicate: (snapshot: PublicSnapshot<State>) => boolean | Promise<boolean>,
        description?: string,
        options?: PublicBarrierOptions,
    ) => Promise<PublicSnapshot<State>>;
    readonly waitForCursor: (
        predicate: (cursor: string | undefined) => boolean,
        description?: string,
        options?: PublicBarrierOptions,
    ) => Promise<PublicSnapshot<State>>;
}

/**
 * Build an observable-state barrier. Scenarios pass public client reads (or
 * their public event journal reads) as `read`; no module, store, or timer
 * internals are involved.
 */
export function createPublicStateBarrier<State>(
    read: () => Promise<PublicSnapshot<State>>,
    defaults: PublicBarrierOptions = {},
): PublicStateBarrier<State> {
    return {
        read,
        waitFor: async (predicate, description, options) =>
            await waitForPublicState(read, predicate, mergeOptions(defaults, options), description),
        waitForCursor: async (predicate, description, options) =>
            await waitForPublicState(
                read,
                (snapshot) => predicate(snapshot.cursor),
                mergeOptions(defaults, options),
                description,
            ),
    };
}

export async function waitForPublicState<State>(
    read: () => Promise<PublicSnapshot<State>>,
    predicate: (snapshot: PublicSnapshot<State>) => boolean | Promise<boolean>,
    options: PublicBarrierOptions = {},
    description = "public state",
): Promise<PublicSnapshot<State>> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 25;
    assertBounds(timeoutMs, pollMs);
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        throwIfAborted(signal);
        const snapshot = await read();
        if (await predicate(snapshot)) return snapshot;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(
                `Timed out after ${String(timeoutMs)}ms waiting for ${description}. ` +
                    `Last cursor: ${snapshot.cursor ?? "unknown"}`,
            );
        }
        await delayWithAbort(Math.min(pollMs, remaining), signal);
    }
}

export async function waitForPublicEvent<Event>(
    readEvents: () => Promise<readonly Event[]>,
    predicate: (event: Event) => boolean | Promise<boolean>,
    options: PublicBarrierOptions = {},
    description = "public event",
): Promise<Event> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 25;
    assertBounds(timeoutMs, pollMs);
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    let count = 0;

    for (;;) {
        throwIfAborted(signal);
        const events = await readEvents();
        // Re-evaluate the complete public event list. Event cursors are
        // authoritative; a concurrent mutation can append between reads.
        for (const event of events) {
            if (await predicate(event)) return event;
        }
        count = events.length;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(
                `Timed out after ${String(timeoutMs)}ms waiting for ${description}. ` +
                    `Observed ${String(count)} public events.`,
            );
        }
        await delayWithAbort(Math.min(pollMs, remaining), signal);
    }
}

export async function waitForPublicChange<State>(
    read: () => Promise<PublicSnapshot<State>>,
    previous: PublicSnapshot<State>,
    equal: (before: State, after: State) => boolean,
    options: PublicBarrierOptions = {},
    description = "public state change",
): Promise<PublicSnapshot<State>> {
    return await waitForPublicState(
        read,
        (snapshot) => !equal(previous.state, snapshot.state),
        options,
        description,
    );
}

function mergeOptions(
    defaults: PublicBarrierOptions,
    overrides: PublicBarrierOptions | undefined,
): PublicBarrierOptions {
    return {
        ...defaults,
        ...overrides,
        ...(overrides?.signal === undefined && defaults.signal !== undefined
            ? { signal: defaults.signal }
            : {}),
    };
}

function assertBounds(timeoutMs: number, pollMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new RangeError("Public barrier timeoutMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
        throw new RangeError("Public barrier pollMs must be a positive safe integer.");
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw signal.reason ?? new Error("Public barrier aborted.");
}

async function delayWithAbort(
    milliseconds: number,
    signal: AbortSignal | undefined,
): Promise<void> {
    if (signal === undefined) {
        await sleep(milliseconds);
        return;
    }
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        const abort = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(signal.reason ?? new Error("Public barrier aborted."));
        };
        signal.addEventListener("abort", abort, { once: true });
        timer.unref?.();
    });
}
