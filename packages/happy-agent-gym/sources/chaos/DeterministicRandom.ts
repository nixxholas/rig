/**
 * Small deterministic primitives shared by the public API chaos scenarios.
 *
 * The generator is deliberately self-contained. A chaos run must not depend on
 * process-global randomness, test order, wall-clock time, or another worker.
 */

export interface ChaosSeed {
    readonly label: string;
    readonly value: number;
}

export class DeterministicRandom {
    #state: number;

    constructor(seed: number | string) {
        this.#state = normalizeSeed(hashChaosSeed(seed));
    }

    /** The next unsigned 32-bit value. */
    nextUint32(): number {
        // xorshift32 has a tiny state and is sufficient for choosing actions. The
        // state is explicitly unsigned after every operation for cross-runtime
        // consistency.
        let state = this.#state;
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        this.#state = normalizeSeed(state);
        return this.#state;
    }

    /** A value in the half-open interval [0, 1). */
    nextFloat(): number {
        return this.nextUint32() / 0x1_0000_0000;
    }

    /** An integer in the half-open interval [minimum, maximumExclusive). */
    int(minimum: number, maximumExclusive: number): number {
        if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximumExclusive)) {
            throw new RangeError("DeterministicRandom bounds must be safe integers.");
        }
        if (maximumExclusive <= minimum) {
            throw new RangeError("DeterministicRandom requires maximumExclusive > minimum.");
        }
        const width = maximumExclusive - minimum;
        return minimum + Math.floor(this.nextFloat() * width);
    }

    bool(probability = 0.5): boolean {
        if (!(probability >= 0 && probability <= 1)) {
            throw new RangeError("DeterministicRandom probability must be between 0 and 1.");
        }
        return this.nextFloat() < probability;
    }

    pick<T>(values: readonly T[]): T {
        if (values.length === 0) throw new RangeError("Cannot pick from an empty list.");
        return values[this.int(0, values.length)] as T;
    }

    /**
     * Fork without consuming the parent's state. This keeps independently
     * generated action arguments stable when a caller adds another choice.
     */
    fork(label: string): DeterministicRandom {
        return new DeterministicRandom(`${this.#state}:${label}`);
    }
}

export function hashChaosSeed(seed: number | string): number {
    if (typeof seed === "number") {
        if (!Number.isSafeInteger(seed)) {
            throw new RangeError("Chaos seed numbers must be safe integers.");
        }
        return normalizeSeed(seed);
    }

    // FNV-1a gives a stable, dependency-free mapping for named seeds.
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
        hash ^= seed.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return normalizeSeed(hash);
}

export function namedChaosSeeds(
    prefix: string,
    count: number,
    start = 0,
    padding = 3,
): readonly ChaosSeed[] {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)) {
        throw new RangeError(`Invalid chaos seed prefix: ${prefix}`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError("Chaos seed count must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(start)) {
        throw new RangeError("Chaos seed start must be a safe integer.");
    }
    if (!Number.isSafeInteger(padding) || padding < 1 || padding > 12) {
        throw new RangeError("Chaos seed padding must be between 1 and 12.");
    }
    return Array.from({ length: count }, (_, index) => {
        const value = start + index;
        return {
            label: `${prefix}${String(value).padStart(padding, "0")}`,
            value,
        };
    });
}

/**
 * Select named seeds with API_CHAOS_SEED-compatible values.
 *
 * A filter is a comma-separated list of exact labels or numeric seed values.
 * `*` selects every seed. Numeric inclusive ranges (`3-7`) are accepted too.
 * An unknown selector is an error: silently running a different seed is worse
 * than failing a focused replay.
 */
export function selectChaosSeeds<T extends ChaosSeed>(
    seeds: readonly T[],
    filter = process.env.API_CHAOS_SEED,
): readonly T[] {
    if (filter === undefined || filter.trim() === "" || filter.trim() === "*") return seeds;

    const selectors = filter
        .split(",")
        .map((selector) => selector.trim())
        .filter((selector) => selector.length > 0);
    const selected = new Map<string, T>();
    const unknown: string[] = [];

    for (const selector of selectors) {
        const exact = seeds.find(
            (seed) => seed.label === selector || String(seed.value) === selector,
        );
        if (exact !== undefined) {
            selected.set(exact.label, exact);
            continue;
        }

        const range = /^(-?\d+)-(-?\d+)$/.exec(selector);
        if (range !== null) {
            const lower = Number(range[1]);
            const upper = Number(range[2]);
            const minimum = Math.min(lower, upper);
            const maximum = Math.max(lower, upper);
            const matches = seeds.filter((seed) => seed.value >= minimum && seed.value <= maximum);
            if (matches.length > 0) {
                for (const seed of matches) selected.set(seed.label, seed);
                continue;
            }
        }
        unknown.push(selector);
    }

    if (unknown.length > 0) {
        throw new Error(
            `API_CHAOS_SEED selected no known seeds: ${unknown.join(", ")}. ` +
                `Known seeds: ${seeds.map((seed) => seed.label).join(", ")}`,
        );
    }
    return seeds.filter((seed) => selected.has(seed.label));
}

export function chaosSeedName(suite: string, seed: ChaosSeed): string {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(suite)) {
        throw new RangeError(`Invalid chaos suite name: ${suite}`);
    }
    return `chaos seed=${suite}-${seed.label}`;
}

function normalizeSeed(value: number): number {
    const normalized = value >>> 0;
    return normalized === 0 ? 0x6d2b79f5 : normalized;
}
