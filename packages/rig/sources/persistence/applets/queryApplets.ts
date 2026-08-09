import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    appletAllowedScopesSchema,
    type Applet,
    type AppletVersion,
} from "../../protocol/AppletProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";
import { appletIconUrl } from "../../applets/readAppletIcon.js";

/** Lists every applet with its complete version history, alphabetically by name. */
export async function queryApplets(tx: DatabaseScope): Promise<readonly Applet[]> {
    return await inDatabase(tx, async (tx) => {
        const appletRows = await tx.all<Record<string, unknown>>(
            sql`SELECT * FROM applets ORDER BY name ASC`,
        );
        const versionRows = await tx.all<Record<string, unknown>>(
            sql`SELECT * FROM applet_versions ORDER BY applet_name ASC, version ASC`,
        );
        const versionsByName = new Map<string, AppletVersion[]>();
        for (const row of versionRows) {
            const name = readString(row, "applet_name");
            const versions = versionsByName.get(name) ?? [];
            versions.push(readAppletVersionRow(row));
            versionsByName.set(name, versions);
        }
        return appletRows.map((row) =>
            readAppletRow(row, versionsByName.get(readString(row, "name")) ?? []),
        );
    });
}

export function readAppletRow(
    row: Record<string, unknown>,
    versions: readonly AppletVersion[],
): Applet {
    const sourceDescription = readOptionalString(row, "source_description");
    return {
        allowedScopes: Value.Decode(
            appletAllowedScopesSchema,
            JSON.parse(readString(row, "allowed_scopes_json")),
        ),
        name: readString(row, "name"),
        description: readString(row, "description"),
        purpose: readString(row, "purpose"),
        iconThumbhash: readString(row, "icon_thumbhash"),
        iconUrl: appletIconUrl(readString(row, "name")),
        authorSessionId: readString(row, "author_session_id"),
        ...(sourceDescription === undefined ? {} : { sourceDescription }),
        currentVersion: readNumber(row, "current_version"),
        versions: [...versions],
        createdAt: readNumber(row, "created_at_ms"),
        updatedAt: readNumber(row, "updated_at_ms"),
    };
}

export function readAppletVersionRow(row: Record<string, unknown>): AppletVersion {
    return {
        version: readNumber(row, "version"),
        changeDescription: readString(row, "change_description"),
        createdAt: readNumber(row, "created_at_ms"),
    };
}
