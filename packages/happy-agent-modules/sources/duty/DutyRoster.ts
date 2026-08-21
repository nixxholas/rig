import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "smol-toml";

import {
    dutyDeclarationSchema,
    MAX_DUTY_INTERVAL_MS,
    MIN_DUTY_INTERVAL_MS,
    type DutyDeclaration,
} from "./Duty.js";

/** The roster file's name inside the machine's Happy config folder. */
export const DUTY_ROSTER_FILE_NAME = "duties.toml";

/** A misdeclared roster must not be able to make startup unbounded work. */
const MAX_ROSTER_ENTRIES = 64;

export const dutyRosterSchema = Type.Object(
    {
        /** Whether omission means removal, rather than a read or validation failure. */
        authoritative: Type.Boolean(),
        declarations: Type.Array(dutyDeclarationSchema, { maxItems: MAX_ROSTER_ENTRIES }),
        /** Bounded, human-readable reasons entries were rejected; startup logs these and continues. */
        notices: Type.Array(Type.String()),
    },
    { additionalProperties: false },
);

export type DutyRoster = Static<typeof dutyRosterSchema>;

/** A stable identity for every authority-bearing field in one declaration. */
export function dutyDeclarationHash(declaration: DutyDeclaration): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                ...declaration,
                allowedTools: [...declaration.allowedTools].sort(),
                every: declaration.every ?? null,
            }),
            "utf8",
        )
        .digest("hex");
}

/**
 * Read the machine's Duty roster.
 *
 * The roster is machine-scoped by living beside `happy.toml` in the config home, which is the same
 * place `AGENTS.md` and `SECURITY.md` already sit: a checked-in project file cannot issue a Duty,
 * so an agent cannot widen its own authority by writing a file into a repository it works on.
 *
 * A missing file is a valid empty roster. One bad entry is skipped with a notice rather than
 * failing the daemon, because a Duty is not worth refusing to boot over — but a file that does not
 * parse at all is reported as a single notice for the same reason.
 */
export async function readDutyRoster(configHome: string): Promise<DutyRoster> {
    const path = resolve(configHome, DUTY_ROSTER_FILE_NAME);
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error: unknown) {
        if ((error as { code?: string } | undefined)?.code === "ENOENT") {
            return { authoritative: true, declarations: [], notices: [] };
        }
        return {
            authoritative: false,
            declarations: [],
            notices: [`The Duty roster at ${path} could not be read.`],
        };
    }
    return parseDutyRoster(text, path);
}

/** Parse roster text. Exported so a test can exercise every rejection without touching a disk. */
export function parseDutyRoster(text: string, path = DUTY_ROSTER_FILE_NAME): DutyRoster {
    let table: unknown;
    try {
        table = parse(text);
    } catch (error: unknown) {
        return {
            authoritative: false,
            declarations: [],
            notices: [`The Duty roster at ${path} is not valid TOML: ${errorText(error)}`],
        };
    }
    if (!isTable(table)) {
        return {
            authoritative: false,
            declarations: [],
            notices: [`The Duty roster at ${path} is not a TOML table.`],
        };
    }
    const entries = table["duty"];
    if (entries === undefined) return { authoritative: true, declarations: [], notices: [] };
    if (!Array.isArray(entries)) {
        return {
            authoritative: false,
            declarations: [],
            notices: [`${path}: duty must be an array of tables.`],
        };
    }

    const declarations: DutyDeclaration[] = [];
    const notices: string[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
        if (declarations.length >= MAX_ROSTER_ENTRIES) {
            notices.push(`${path}: only the first ${String(MAX_ROSTER_ENTRIES)} duties are read.`);
            break;
        }
        const where = `${path}: duty[${String(index)}]`;
        try {
            const declaration = readDeclaration(entry);
            // Two entries sharing an ID would fight over one binding forever, each reissuing what
            // the other just replaced, so the collision is refused rather than resolved by order.
            if (seen.has(declaration.dutyId)) {
                notices.push(`${where} repeats the duty ID "${declaration.dutyId}".`);
                continue;
            }
            seen.add(declaration.dutyId);
            declarations.push(declaration);
        } catch (error: unknown) {
            notices.push(`${where} was skipped: ${errorText(error)}`);
        }
    }
    return { authoritative: notices.length === 0, declarations, notices };
}

function readDeclaration(entry: unknown): DutyDeclaration {
    if (!isTable(entry)) throw new Error("it is not a TOML table.");
    const known = new Set([
        "allowed_tools",
        "charter",
        "every",
        "id",
        "permission_ceiling",
        "project",
        "tenure",
        "trigger",
    ]);
    for (const key of Object.keys(entry)) {
        if (!known.has(key)) throw new Error(`"${key}" is not a Duty setting.`);
    }
    const project = requireString(entry["project"], "project");
    // A relative project path would resolve against whatever directory the daemon happened to start
    // in, so the same roster would bind a different folder depending on how Rig was launched.
    if (!isAbsolute(project)) throw new Error("project must be an absolute path.");
    const declaration = {
        allowedTools: requireToolList(entry["allowed_tools"]),
        charter: requireString(entry["charter"], "charter").trim(),
        dutyId: requireString(entry["id"], "id"),
        ...(entry["every"] === undefined
            ? {}
            : { every: requireInterval(entry["every"] as unknown) }),
        permissionCeiling: requireString(entry["permission_ceiling"], "permission_ceiling"),
        project,
        // A roster that names no tenure is declaring the Duty's first one; naming it explicitly is
        // how an operator hands the same responsibility to a fresh holder.
        tenureId:
            entry["tenure"] === undefined ? "tenure-1" : requireString(entry["tenure"], "tenure"),
        trigger: requireString(entry["trigger"], "trigger").trim(),
    };
    if (!Value.Check(dutyDeclarationSchema, declaration)) {
        throw new Error("it is not a valid Duty declaration.");
    }
    return declaration;
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value;
}

function requireToolList(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error("allowed_tools must be an array of tool names.");
    return value.map((item, index) => requireString(item, `allowed_tools[${String(index)}]`));
}

/** `30m`, `2h`, `45 minutes` — the same duration spellings the scheduling tools accept. */
const DURATION_PATTERN =
    /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/;
const DURATION_UNITS: Readonly<Record<string, number>> = {
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    ms: 1,
    s: 1_000,
    sec: 1_000,
    second: 1_000,
    seconds: 1_000,
};

function requireInterval(value: unknown): number {
    const milliseconds = intervalMilliseconds(value);
    if (milliseconds < MIN_DUTY_INTERVAL_MS || milliseconds > MAX_DUTY_INTERVAL_MS) {
        throw new Error("every must be between 1 minute and 24 hours.");
    }
    return milliseconds;
}

function intervalMilliseconds(value: unknown): number {
    if (typeof value === "string") {
        const match = DURATION_PATTERN.exec(value.trim().toLowerCase());
        if (match === null) throw new Error(`every is not a duration: "${value}".`);
        const unit = DURATION_UNITS[match[2] as string];
        if (unit === undefined) throw new Error(`every is not a duration: "${value}".`);
        return Math.round(Number(match[1]) * unit);
    }
    throw new Error('every must be a duration such as "30m".');
}

function isTable(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : "it could not be read.";
}
