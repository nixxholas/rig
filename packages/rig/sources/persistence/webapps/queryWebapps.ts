import { sql } from "drizzle-orm";

import type { Webapp, WebappVersion } from "../../protocol/WebappProtocol.js";
import type { TX } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";

/** Lists every webapp with its complete version history, alphabetically by name. */
export function queryWebapps(tx: TX): readonly Webapp[] {
    const webappRows = tx.all<Record<string, unknown>>(
        sql`SELECT * FROM webapps ORDER BY name ASC`,
    );
    const versionRows = tx.all<Record<string, unknown>>(
        sql`SELECT * FROM webapp_versions ORDER BY webapp_name ASC, version ASC`,
    );
    const versionsByName = new Map<string, WebappVersion[]>();
    for (const row of versionRows) {
        const name = readString(row, "webapp_name");
        const versions = versionsByName.get(name) ?? [];
        versions.push(readWebappVersionRow(row));
        versionsByName.set(name, versions);
    }
    return webappRows.map((row) =>
        readWebappRow(row, versionsByName.get(readString(row, "name")) ?? []),
    );
}

export function readWebappRow(
    row: Record<string, unknown>,
    versions: readonly WebappVersion[],
): Webapp {
    const sourceDescription = readOptionalString(row, "source_description");
    return {
        name: readString(row, "name"),
        description: readString(row, "description"),
        purpose: readString(row, "purpose"),
        authorSessionId: readString(row, "author_session_id"),
        ...(sourceDescription === undefined ? {} : { sourceDescription }),
        currentVersion: readNumber(row, "current_version"),
        versions: [...versions],
        createdAt: readNumber(row, "created_at_ms"),
        updatedAt: readNumber(row, "updated_at_ms"),
    };
}

export function readWebappVersionRow(row: Record<string, unknown>): WebappVersion {
    return {
        version: readNumber(row, "version"),
        changeDescription: readString(row, "change_description"),
        createdAt: readNumber(row, "created_at_ms"),
    };
}
