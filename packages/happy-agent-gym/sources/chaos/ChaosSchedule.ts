import {
    ChaosFailure,
    ChaosTraceRecorder,
    digestPublicModel,
    type ChaosTraceRecorderOptions,
} from "./ChaosDiagnostics.js";
import { DeterministicRandom, type ChaosSeed } from "./DeterministicRandom.js";

export interface ChaosActionKind<Action> {
    readonly name: string;
    readonly create: (random: DeterministicRandom, index: number) => Action;
}

export function generateChaosSchedule<Action>(
    seed: ChaosSeed | number | string,
    length: number,
    kinds: readonly ChaosActionKind<Action>[],
): readonly Action[] {
    if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError("Chaos schedule length must be a non-negative safe integer.");
    }
    if (kinds.length === 0 && length > 0) {
        throw new RangeError("Chaos schedules need at least one action kind.");
    }

    const random = new DeterministicRandom(seedFor(seed));
    return Array.from({ length }, (_, index) => {
        const kind = random.pick(kinds);
        return kind.create(random.fork(`${kind.name}:${String(index)}`), index);
    });
}

export function replayPrefix<Action>(
    schedule: readonly Action[],
    length: number | undefined,
): readonly Action[] {
    if (length === undefined) return schedule;
    if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError("Chaos replay prefix must be a non-negative safe integer.");
    }
    return schedule.slice(0, length);
}

export interface ChaosStepResult<State> {
    readonly state: State;
    readonly cursor?: string;
    readonly details?: unknown;
}

export interface ChaosExecutionResult<State> {
    readonly state: State | undefined;
    readonly completedSteps: number;
    readonly trace: ChaosTraceRecorder;
}

export interface ChaosScheduleOptions<Action, State> {
    readonly suite: string;
    readonly seed: ChaosSeed | string;
    readonly schedule: readonly Action[];
    readonly apply: (
        action: Action,
        step: number,
        signal: AbortSignal,
    ) => Promise<ChaosStepResult<State>>;
    readonly assert?: (
        state: State,
        action: Action,
        step: number,
        signal: AbortSignal,
    ) => void | Promise<void>;
    readonly signal?: AbortSignal;
    readonly trace?: ChaosTraceRecorder;
    readonly traceOptions?: ChaosTraceRecorderOptions;
    readonly actionName?: (action: Action, step: number) => string;
    readonly onStep?: (
        result: ChaosStepResult<State>,
        action: Action,
        step: number,
    ) => void | Promise<void>;
}

/**
 * Execute a pre-generated public action schedule exactly once.
 *
 * The runner records each successful public observation and wraps the first
 * failed action with enough information to replay the same prefix. It never
 * retries an action or advances after an assertion failure.
 */
export async function runChaosSchedule<Action, State>(
    options: ChaosScheduleOptions<Action, State>,
): Promise<ChaosExecutionResult<State>> {
    const trace = options.trace ?? new ChaosTraceRecorder(options.traceOptions);
    let state: State | undefined;
    const signal = options.signal ?? new AbortController().signal;

    for (let step = 0; step < options.schedule.length; step += 1) {
        const action = options.schedule[step] as Action;
        const actionLabel = options.actionName?.(action, step) ?? describeAction(action, step);
        if (signal.aborted) {
            throw new ChaosFailure(
                {
                    suite: options.suite,
                    seed: seedLabel(options.seed),
                    step,
                    action: actionLabel,
                    trace,
                },
                signal.reason ?? new Error("Chaos schedule aborted."),
            );
        }

        let result: ChaosStepResult<State>;
        try {
            result = await options.apply(action, step, signal);
            await options.assert?.(result.state, action, step, signal);
            await options.onStep?.(result, action, step);
        } catch (error: unknown) {
            const modelDigest = state === undefined ? undefined : digestPublicModel(state);
            trace.record({
                suite: options.suite,
                seed: seedLabel(options.seed),
                step,
                action: actionLabel,
                phase: "failed",
                ...(modelDigest === undefined ? {} : { modelDigest }),
                details: error,
            });
            throw new ChaosFailure(
                {
                    suite: options.suite,
                    seed: seedLabel(options.seed),
                    step,
                    action: actionLabel,
                    ...(modelDigest === undefined ? {} : { modelDigest }),
                    trace,
                },
                error,
            );
        }

        state = result.state;
        const modelDigest = digestPublicModel(result.state);
        trace.record({
            suite: options.suite,
            seed: seedLabel(options.seed),
            step,
            action: actionLabel,
            ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
            modelDigest,
            ...(result.details === undefined ? {} : { details: result.details }),
        });
    }

    return {
        state,
        completedSteps: options.schedule.length,
        trace,
    };
}

export interface ChaosReduction<Action> {
    readonly name: string;
    readonly apply: (action: Action) => readonly Action[];
}

export interface ChaosSimplifyOptions {
    readonly maxAttempts?: number;
    readonly signal?: AbortSignal;
}

/**
 * Deterministic delta debugging. `fails` must run the public reproduction from
 * scratch for each candidate. Candidate chunks are always considered left to
 * right, and the granularity change is deterministic.
 */
export async function ddminChaosSchedule<Action>(
    schedule: readonly Action[],
    fails: (candidate: readonly Action[], signal: AbortSignal) => Promise<boolean>,
    options: ChaosSimplifyOptions = {},
): Promise<readonly Action[]> {
    const signal = options.signal ?? new AbortController().signal;
    const maxAttempts = options.maxAttempts ?? 256;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError("Chaos simplification maxAttempts must be positive.");
    }

    let current = [...schedule];
    let granularity = 2;
    let attempts = 0;
    while (current.length > 1 && attempts < maxAttempts) {
        if (signal.aborted) throw signal.reason ?? new Error("Chaos simplification aborted.");
        const chunkSize = Math.max(1, Math.ceil(current.length / granularity));
        let reduced = false;
        for (let start = 0; start < current.length && attempts < maxAttempts; start += chunkSize) {
            const candidate = current.slice(0, start).concat(current.slice(start + chunkSize));
            attempts += 1;
            if (await fails(candidate, signal)) {
                current = candidate;
                granularity = Math.max(2, granularity - 1);
                reduced = true;
                break;
            }
        }
        if (!reduced) {
            if (granularity >= current.length) break;
            granularity = Math.min(current.length, granularity * 2);
        }
    }
    return current;
}

export async function simplifyChaosSchedule<Action>(
    schedule: readonly Action[],
    fails: (candidate: readonly Action[], signal: AbortSignal) => Promise<boolean>,
    reductions: readonly ChaosReduction<Action>[],
    options: ChaosSimplifyOptions = {},
): Promise<readonly Action[]> {
    let current = await ddminChaosSchedule(schedule, fails, options);
    const signal = options.signal ?? new AbortController().signal;
    const maxAttempts = options.maxAttempts ?? 256;
    let attempts = 0;

    for (const reduction of reductions) {
        for (let index = 0; index < current.length && attempts < maxAttempts; index += 1) {
            for (const replacement of reduction.apply(current[index] as Action)) {
                if (attempts >= maxAttempts) break;
                if (signal.aborted)
                    throw signal.reason ?? new Error("Chaos simplification aborted.");
                const candidate = [...current];
                candidate.splice(index, 1, replacement);
                attempts += 1;
                if (await fails(candidate, signal)) {
                    current = candidate;
                    break;
                }
            }
        }
    }
    return current;
}

function seedFor(seed: ChaosSeed | number | string): string {
    if (typeof seed === "object") return `${seed.label}:${String(seed.value)}`;
    return String(seed);
}

function seedLabel(seed: ChaosSeed | string): string {
    return typeof seed === "string" ? seed : seed.label;
}

function describeAction<Action>(action: Action, step: number): string {
    if (action !== null && typeof action === "object") {
        const value = action as { readonly kind?: unknown; readonly type?: unknown };
        if (typeof value.kind === "string") return value.kind;
        if (typeof value.type === "string") return value.type;
    }
    return `step-${String(step)}`;
}
