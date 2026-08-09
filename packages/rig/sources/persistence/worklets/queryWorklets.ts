import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    workletPermissionsSchema,
    type WorkletPermissions,
    type WorkletVersion,
} from "../../protocol/WorkletProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";
import { workletIconUrl } from "../../worklets/readWorkletIcon.js";

/**
 * The stored half of a worklet. Whether it is running, what it says about itself, and which tools
 * it registered are live facts the manager owns, so they are not read from the database.
 *
 * What the worklet does and what it may touch come from the manifest of whichever version is
 * current, so they are read off that version rather than stored a second time.
 */
export interface StoredWorklet {
    authorSessionId: string;
    createdAt: number;
    currentVersion: number;
    description: string;
    iconThumbhash: string;
    iconUrl: string;
    name: string;
    permissions: WorkletPermissions;
    sourceDescription?: string;
    updatedAt: number;
    versions: readonly WorkletVersion[];
}

/** Lists every worklet with its complete version history, alphabetically by name. */
export async function queryWorklets(tx: DatabaseScope): Promise<readonly StoredWorklet[]> {
    return await inDatabase(tx, async (tx) => {
        const workletRows = await tx.all<Record<string, unknown>>(
            sql`SELECT * FROM worklets ORDER BY name ASC`,
        );
        const versionRows = await tx.all<Record<string, unknown>>(
            sql`SELECT * FROM worklet_versions ORDER BY worklet_name ASC, version ASC`,
        );
        const versionsByName = new Map<string, WorkletVersion[]>();
        for (const row of versionRows) {
            const name = readString(row, "worklet_name");
            const versions = versionsByName.get(name) ?? [];
            versions.push(readWorkletVersionRow(row));
            versionsByName.set(name, versions);
        }
        return workletRows.map((row) =>
            readWorkletRow(row, versionsByName.get(readString(row, "name")) ?? []),
        );
    });
}

export function readWorkletRow(
    row: Record<string, unknown>,
    versions: readonly WorkletVersion[],
): StoredWorklet {
    const name = readString(row, "name");
    const currentVersion = readNumber(row, "current_version");
    const current = versions.find((version) => version.version === currentVersion);
    if (current === undefined) {
        throw new Error(
            `The worklet ${JSON.stringify(name)} has no stored version v${String(currentVersion)}.`,
        );
    }
    const sourceDescription = readOptionalString(row, "source_description");
    return {
        name,
        description: current.description,
        permissions: current.permissions,
        iconThumbhash: readString(row, "icon_thumbhash"),
        iconUrl: workletIconUrl(name),
        authorSessionId: readString(row, "author_session_id"),
        ...(sourceDescription === undefined ? {} : { sourceDescription }),
        currentVersion,
        versions: [...versions],
        createdAt: readNumber(row, "created_at_ms"),
        updatedAt: readNumber(row, "updated_at_ms"),
    };
}

export function readWorkletVersionRow(row: Record<string, unknown>): WorkletVersion {
    return {
        version: readNumber(row, "version"),
        changeDescription: readString(row, "change_description"),
        createdAt: readNumber(row, "created_at_ms"),
        description: readString(row, "description"),
        permissions: readWorkletPermissions(row),
    };
}

function readWorkletPermissions(row: Record<string, unknown>): WorkletPermissions {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readString(row, "permissions_json")) as unknown;
    } catch {
        throw new Error("The stored worklet permissions are not valid JSON.");
    }
    if (!Value.Check(workletPermissionsSchema, parsed)) {
        throw new Error("The stored worklet permissions are not a valid permission set.");
    }
    return parsed;
}
