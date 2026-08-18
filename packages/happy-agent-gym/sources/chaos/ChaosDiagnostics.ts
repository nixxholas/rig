import { createHash } from "node:crypto";

export interface ChaosSanitizerOptions {
    readonly maxDepth?: number;
    readonly maxStringLength?: number;
    readonly maxArrayLength?: number;
    readonly maxObjectKeys?: number;
    readonly redactedKeys?: readonly RegExp[];
}

export type SanitizedTraceValue =
    | null
    | boolean
    | number
    | string
    | readonly SanitizedTraceValue[]
    | { readonly [key: string]: SanitizedTraceValue };

const DEFAULT_REDACTED_KEYS: readonly RegExp[] = [
    /authorization/i,
    /cookie/i,
    /credential/i,
    /password/i,
    /private[-_]?key/i,
    /secret/i,
    /token/i,
    /api[-_]?key/i,
    /access[-_]?key/i,
    /(?:^|[-_])(home|cwd|path|socket|database|workspace)(?:$|[-_])/i,
];

/**
 * Turn arbitrary public responses and action details into a bounded,
 * deterministic, non-sensitive trace value.
 */
export function sanitizeTraceValue(
    value: unknown,
    options: ChaosSanitizerOptions = {},
): SanitizedTraceValue {
    const settings = {
        maxDepth: options.maxDepth ?? 6,
        maxStringLength: options.maxStringLength ?? 512,
        maxArrayLength: options.maxArrayLength ?? 64,
        maxObjectKeys: options.maxObjectKeys ?? 96,
        redactedKeys: options.redactedKeys ?? DEFAULT_REDACTED_KEYS,
    };
    const seen = new WeakSet<object>();

    const visit = (candidate: unknown, depth: number): SanitizedTraceValue => {
        if (candidate === null) return null;
        if (typeof candidate === "string") return boundString(candidate, settings.maxStringLength);
        if (typeof candidate === "boolean") return candidate;
        if (typeof candidate === "number") {
            if (Number.isNaN(candidate)) return "[NaN]";
            if (candidate === Number.POSITIVE_INFINITY) return "[Infinity]";
            if (candidate === Number.NEGATIVE_INFINITY) return "[-Infinity]";
            return candidate;
        }
        if (typeof candidate === "bigint") return `${candidate.toString()}n`;
        if (typeof candidate === "undefined") return "[undefined]";
        if (typeof candidate === "function") return "[function]";
        if (typeof candidate === "symbol") return `[symbol ${String(candidate)}]`;
        if (depth >= settings.maxDepth) return "[truncated]";

        if (candidate instanceof Error) {
            return {
                name: boundString(candidate.name, settings.maxStringLength),
                message: boundString(candidate.message, settings.maxStringLength),
            };
        }
        if (candidate instanceof Date) {
            return Number.isNaN(candidate.getTime()) ? "[invalid date]" : candidate.toISOString();
        }
        if (candidate instanceof Uint8Array || ArrayBuffer.isView(candidate)) {
            return {
                type: "bytes",
                length: candidate.byteLength,
            };
        }
        if (candidate instanceof ArrayBuffer) {
            return { type: "bytes", length: candidate.byteLength };
        }
        if (seen.has(candidate)) return "[circular]";
        seen.add(candidate);

        if (Array.isArray(candidate)) {
            const values = candidate
                .slice(0, settings.maxArrayLength)
                .map((item) => visit(item, depth + 1));
            if (candidate.length > settings.maxArrayLength) {
                values.push(`[${String(candidate.length - settings.maxArrayLength)} more]`);
            }
            seen.delete(candidate);
            return values;
        }
        if (candidate instanceof Map) {
            const entries = Array.from(candidate.entries())
                .slice(0, settings.maxArrayLength)
                .map(([key, item]) => [visit(key, depth + 1), visit(item, depth + 1)]);
            seen.delete(candidate);
            return {
                type: "map",
                entries,
            };
        }
        if (candidate instanceof Set) {
            const values = Array.from(candidate.values())
                .slice(0, settings.maxArrayLength)
                .map((item) => visit(item, depth + 1));
            seen.delete(candidate);
            return {
                type: "set",
                values,
            };
        }

        const object = candidate as Record<string, unknown>;
        const keys = Object.keys(object).sort().slice(0, settings.maxObjectKeys);
        const result: Record<string, SanitizedTraceValue> = {};
        for (const key of keys) {
            if (settings.redactedKeys.some((pattern) => pattern.test(key))) {
                result[key] = "[redacted]";
            } else {
                result[key] = visit(object[key], depth + 1);
            }
        }
        if (Object.keys(object).length > settings.maxObjectKeys) {
            result.__truncatedKeys = `[${String(Object.keys(object).length - settings.maxObjectKeys)} more]`;
        }
        seen.delete(candidate);
        return result;
    };

    return visit(value, 0);
}

export function stableTraceString(value: unknown, options?: ChaosSanitizerOptions): string {
    return JSON.stringify(sanitizeTraceValue(value, options));
}

export function digestPublicModel(value: unknown, options?: ChaosSanitizerOptions): string {
    return createHash("sha256").update(stableTraceString(value, options)).digest("hex");
}

export interface ChaosTraceEntryInput {
    readonly suite: string;
    readonly seed: string;
    readonly step: number;
    readonly action: unknown;
    readonly phase?: string;
    readonly cursor?: string;
    readonly modelDigest?: string;
    readonly details?: unknown;
}

export interface ChaosTraceEntry {
    readonly suite: string;
    readonly seed: string;
    readonly step: number;
    readonly action: SanitizedTraceValue;
    readonly phase?: string;
    readonly cursor?: string;
    readonly modelDigest?: string;
    readonly details?: SanitizedTraceValue;
}

export interface ChaosTraceRecorderOptions extends ChaosSanitizerOptions {
    readonly maxEntries?: number;
}

/**
 * Bounded trace storage. The first entries are retained because they describe
 * the deterministic prefix; the dropped count tells a failure reporter that
 * the tail was intentionally bounded.
 */
export class ChaosTraceRecorder {
    readonly #options: ChaosTraceRecorderOptions;
    readonly #entries: ChaosTraceEntry[] = [];
    #dropped = 0;

    constructor(options: ChaosTraceRecorderOptions = {}) {
        const maxEntries = options.maxEntries ?? 512;
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
            throw new RangeError("Chaos trace maxEntries must be a positive safe integer.");
        }
        this.#options = options;
    }

    record(input: ChaosTraceEntryInput): ChaosTraceEntry {
        const entry = sanitizeTraceEntry(input, this.#options);
        const maxEntries = this.#options.maxEntries ?? 512;
        if (this.#entries.length < maxEntries) this.#entries.push(entry);
        else this.#dropped += 1;
        return entry;
    }

    get entries(): readonly ChaosTraceEntry[] {
        return this.#entries;
    }

    get dropped(): number {
        return this.#dropped;
    }

    toJSON(): {
        readonly entries: readonly ChaosTraceEntry[];
        readonly dropped: number;
    } {
        return {
            entries: this.#entries,
            dropped: this.#dropped,
        };
    }

    format(): string {
        return JSON.stringify(this.toJSON());
    }
}

export interface ChaosFailureContext {
    readonly suite: string;
    readonly seed: string;
    readonly step: number;
    readonly action: unknown;
    readonly cursor?: string;
    readonly modelDigest?: string;
    readonly trace?: ChaosTraceRecorder;
}

export class ChaosFailure extends Error {
    readonly context: ChaosFailureContext;
    readonly original: unknown;

    constructor(context: ChaosFailureContext, original: unknown) {
        super(formatChaosFailure(context, original));
        this.name = "ChaosFailure";
        this.context = context;
        this.original = original;
    }

    toJSON(): {
        readonly name: string;
        readonly message: string;
        readonly suite: string;
        readonly seed: string;
        readonly step: number;
        readonly cursor?: string;
        readonly modelDigest?: string;
        readonly trace?: ReturnType<ChaosTraceRecorder["toJSON"]>;
    } {
        const value: {
            name: string;
            message: string;
            suite: string;
            seed: string;
            step: number;
            cursor?: string;
            modelDigest?: string;
            trace?: ReturnType<ChaosTraceRecorder["toJSON"]>;
        } = {
            name: this.name,
            message: this.message,
            suite: this.context.suite,
            seed: this.context.seed,
            step: this.context.step,
        };
        if (this.context.cursor !== undefined) value.cursor = this.context.cursor;
        if (this.context.modelDigest !== undefined) value.modelDigest = this.context.modelDigest;
        if (this.context.trace !== undefined) value.trace = this.context.trace.toJSON();
        return value;
    }
}

function sanitizeTraceEntry(
    input: ChaosTraceEntryInput,
    options: ChaosSanitizerOptions,
): ChaosTraceEntry {
    const entry: {
        suite: string;
        seed: string;
        step: number;
        action: SanitizedTraceValue;
        phase?: string;
        cursor?: string;
        modelDigest?: string;
        details?: SanitizedTraceValue;
    } = {
        suite: boundString(input.suite, 160),
        seed: boundString(input.seed, 160),
        step: input.step,
        action: sanitizeTraceValue(input.action, options),
    };
    if (input.phase !== undefined) entry.phase = boundString(input.phase, 80);
    if (input.cursor !== undefined) entry.cursor = boundString(input.cursor, 256);
    if (input.modelDigest !== undefined) {
        entry.modelDigest = boundString(input.modelDigest, 128);
    }
    if (input.details !== undefined) entry.details = sanitizeTraceValue(input.details, options);
    return entry;
}

function formatChaosFailure(context: ChaosFailureContext, original: unknown): string {
    const reason =
        original instanceof Error
            ? `${original.name}: ${original.message}`
            : String(sanitizeTraceValue(original));
    const model = context.modelDigest === undefined ? "unknown" : context.modelDigest;
    const cursor = context.cursor === undefined ? "unknown" : context.cursor;
    return (
        `Chaos failure suite=${context.suite} seed=${context.seed} step=${String(context.step)} ` +
        `modelDigest=${model} cursor=${cursor}: ${reason}`
    );
}

function boundString(value: string, maximum: number): string {
    if (value.length <= maximum) return value;
    return `${value.slice(0, Math.max(0, maximum - 24))}…[${String(value.length)} chars]`;
}
