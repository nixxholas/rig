import { MAX_WAIT_MS } from "./types.js";

export interface DurationInput {
    days?: number;
    duration?: string;
    hours?: number;
    seconds?: number;
}

const UNITS: Readonly<Record<string, number>> = {
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    s: 1_000,
    sec: 1_000,
    secs: 1_000,
    second: 1_000,
    seconds: 1_000,
};

export function parseDurationMs(input: DurationInput, maximumMs?: number): number {
    const fields = [input.seconds, input.hours, input.days].filter(
        (value): value is number => value !== undefined,
    );
    if (fields.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error("Every duration field must be a non-negative finite number.");
    }
    if (input.duration !== undefined && fields.length > 0) {
        throw new Error("Use either duration or the seconds, hours, and days fields, not both.");
    }
    const milliseconds =
        input.duration === undefined
            ? (input.seconds ?? 0) * 1_000 +
              (input.hours ?? 0) * 3_600_000 +
              (input.days ?? 0) * 86_400_000
            : parseDurationText(input.duration);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("The duration must be a non-negative finite amount of time.");
    }
    if (milliseconds === 0 && input.duration === undefined && fields.length === 0) {
        throw new Error("Provide a duration in seconds, hours, days, or duration text.");
    }
    if (maximumMs !== undefined && milliseconds > maximumMs) {
        throw new Error(`The duration cannot exceed ${String(maximumMs / 3_600_000)} hours.`);
    }
    return milliseconds;
}

export function parseDateMs(value: string | number): number {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("The scheduled date must be finite.");
        return value < 1_000_000_000_000 ? value * 1_000 : value;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error("Provide a scheduled date.");
    if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return parseDateMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
        throw new Error(
            "The date could not be understood. Use ISO 8601, RFC 2822, or a Unix timestamp.",
        );
    }
    return parsed;
}

export function parseWaitUntilMs(value: string | number, now: number): number {
    const dueAt = parseDateMs(value);
    if (dueAt - now > MAX_WAIT_MS) {
        throw new Error("The wait cannot end more than 24 hours from now.");
    }
    return Math.max(now, dueAt);
}

function parseDurationText(value: string): number {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) throw new Error("Provide a duration.");
    let total = 0;
    let matchedThrough = 0;
    const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/gu;
    for (const match of normalized.matchAll(pattern)) {
        const between = normalized.slice(matchedThrough, match.index).trim();
        if (between.length > 0 && between !== ",") {
            throw new Error(
                `The duration could not be understood near ${JSON.stringify(between)}.`,
            );
        }
        const unit = UNITS[match[2] ?? ""];
        if (unit === undefined) {
            throw new Error(`Unknown duration unit ${JSON.stringify(match[2])}.`);
        }
        total += Number(match[1]) * unit;
        matchedThrough = (match.index ?? 0) + match[0].length;
    }
    if (matchedThrough === 0 || normalized.slice(matchedThrough).trim().length > 0) {
        throw new Error(
            "The duration could not be understood. Examples: 90 seconds, 2 hours, 1h 30m.",
        );
    }
    return total;
}
