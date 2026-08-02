import { sql, type SQL } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    slotEntryAuthorSchema,
    type SlotContent,
    type SlotEntry,
    type SlotEntryFilter,
} from "../../protocol/SlotProtocol.js";
import type { TX } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";

/**
 * Lists slot entries, oldest first. A scope-context filter matches `everywhere` entries plus the
 * entries scoped to each provided project, workspace, or session; without context ids every entry
 * is returned. The filtering happens in SQL before any content payload is deserialized.
 */
export function querySlotEntries(tx: TX, filter: SlotEntryFilter = {}): readonly SlotEntry[] {
    const conditions: SQL[] = [];
    if (filter.slot !== undefined) conditions.push(sql`slot = ${filter.slot}`);
    const scopeClauses: SQL[] = [];
    if (filter.projectId !== undefined) {
        scopeClauses.push(sql`(scope = 'project' AND project_id = ${filter.projectId})`);
    }
    if (filter.workspaceId !== undefined) {
        scopeClauses.push(sql`(scope = 'workspace' AND workspace_id = ${filter.workspaceId})`);
    }
    if (filter.sessionId !== undefined) {
        scopeClauses.push(sql`(scope = 'session' AND session_id = ${filter.sessionId})`);
    }
    if (scopeClauses.length > 0) {
        scopeClauses.unshift(sql`scope = 'everywhere'`);
        conditions.push(sql`(${sql.join(scopeClauses, sql` OR `)})`);
    }
    const where = conditions.length === 0 ? sql`` : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
    return tx
        .all<Record<string, unknown>>(
            sql`SELECT * FROM slot_entries${where} ORDER BY created_at_ms ASC, id ASC`,
        )
        .map(readSlotEntryRow);
}

export function readSlotEntryRow(row: Record<string, unknown>): SlotEntry {
    const projectId = readOptionalString(row, "project_id");
    const workspaceId = readOptionalString(row, "workspace_id");
    const sessionId = readOptionalString(row, "session_id");
    const authorType = readString(row, "author_type");
    const authorId = readString(row, "author_id");
    return {
        id: readString(row, "id"),
        slot: readString(row, "slot") as SlotEntry["slot"],
        scope: readString(row, "scope") as SlotEntry["scope"],
        ...(projectId === undefined ? {} : { projectId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        content: JSON.parse(readString(row, "content_json")) as SlotContent,
        author: Value.Decode(
            slotEntryAuthorSchema,
            authorType === "plugin"
                ? {
                      type: authorType,
                      folder: authorId,
                      name: readString(row, "author_name"),
                  }
                : { type: authorType, sessionId: authorId },
        ),
        description: readString(row, "description"),
        purpose: readString(row, "purpose"),
        createdAt: readNumber(row, "created_at_ms"),
        updatedAt: readNumber(row, "updated_at_ms"),
    };
}
