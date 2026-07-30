import type { SessionEvent } from "../../../protocol/index.js";
import { readNumber, readString } from "./sqliteRow.js";

export function readSessionEventRow(row: Record<string, unknown>, sessionId: string): SessionEvent {
    return {
        createdAt: readNumber(row, "created_at_ms"),
        data: JSON.parse(readString(row, "data_json")) as SessionEvent["data"],
        id: readString(row, "event_id"),
        sessionId,
        type: readString(row, "type") as SessionEvent["type"],
    } as SessionEvent;
}
