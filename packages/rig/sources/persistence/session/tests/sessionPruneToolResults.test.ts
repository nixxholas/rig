import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentMessage } from "../../../agent/types.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import type { SessionDatabase } from "../../database/openSessionDatabase.js";
import { sessionContextMessages, sessionMessages, sessions } from "../../database/schema.js";
import { sessionPruneToolResults } from "../sessionPruneToolResults.js";

describe("sessionPruneToolResults", () => {
    let opened: ReturnType<typeof openSessionDatabase> | undefined;
    let directory: string | undefined;

    afterEach(async () => {
        opened?.client.close();
        opened = undefined;
        if (directory !== undefined) await rm(directory, { force: true, recursive: true });
        directory = undefined;
    });

    it("removes only stale durable-history payloads and leaves provider context untouched", async () => {
        directory = await mkdtemp(join(tmpdir(), "rig-tool-result-retention-"));
        const path = join(directory, "sessions.sqlite");
        createSessionDatabaseFixture(path);
        opened = openSessionDatabase(path);
        const message = toolResultMessage("result-1", "large-output");
        opened.database
            .insert(sessionMessages)
            .values({
                isPartial: false,
                messageId: message.id,
                messageJson: JSON.stringify(message),
                position: 0,
                role: message.role,
                runId: "run-1",
                sessionId: "session-1",
                updatedAtMs: 1,
            })
            .run();
        opened.database
            .insert(sessionContextMessages)
            .values({
                messageId: message.id,
                messageJson: JSON.stringify(message),
                position: 0,
                role: message.role,
                sessionId: "session-1",
            })
            .run();

        opened.database.update(sessions).set({ lastMessageAtMs: 150, updatedAtMs: 1 }).run();
        expect(sessionPruneToolResults(opened.database, { before: 100, limit: 10 }).pruned).toBe(1);

        opened.database.update(sessions).set({ lastMessageAtMs: 1, updatedAtMs: 150 }).run();
        expect(sessionPruneToolResults(opened.database, { before: 100, limit: 10 }).pruned).toBe(0);

        opened.database
            .update(sessions)
            .set({ lastMessageAtMs: 1, status: "running", updatedAtMs: 1 })
            .run();
        expect(sessionPruneToolResults(opened.database, { before: 100, limit: 10 }).pruned).toBe(0);

        opened.database.update(sessions).set({ status: "idle" }).run();
        expect(sessionPruneToolResults(opened.database, { before: 100, limit: 10 }).pruned).toBe(1);

        const history = readMessage(opened.database, "session_messages");
        expect(history.blocks).toHaveLength(1);
        const block = history.blocks[0];
        expect(block).toMatchObject({
            display: "Read a large file.",
            providerToolCallId: "provider-call-1",
            rendered: [],
            trustedUserEvidence: [{ text: "keep authorization evidence", type: "text" }],
            toolCallId: "call-1",
            toolName: "Read",
            type: "tool_result",
            vendor: { replay: "keep" },
        });
        if (block?.type !== "tool_result" || block.presentation?.type !== "exec_command") {
            throw new Error("Expected a retained command presentation.");
        }
        expect(Array.from(block.presentation.output)).toHaveLength(3_000);
        expect(block.presentation.output).toContain("truncated");
        expect(block.presentation.output).toMatch(/p+$/u);
        expect(readMessage(opened.database, "session_context_messages")).toEqual(message);
        expect(
            opened.database.get<{ message_updated: number; session_updated: number }>(sql`
                SELECT
                    message.updated_at_ms AS message_updated,
                    session.updated_at_ms AS session_updated
                FROM session_messages AS message
                JOIN sessions AS session ON session.id = message.session_id
                WHERE message.session_id = 'session-1'
            `),
        ).toEqual({ message_updated: 1, session_updated: 1 });
        expect(sessionPruneToolResults(opened.database, { before: 100, limit: 10 }).pruned).toBe(0);
    });

    it("advances through bounded pages even when messages need no changes", async () => {
        directory = await mkdtemp(join(tmpdir(), "rig-tool-result-retention-page-"));
        const path = join(directory, "sessions.sqlite");
        createSessionDatabaseFixture(path);
        opened = openSessionDatabase(path);
        for (let position = 0; position < 3; position += 1) {
            const message = {
                blocks: [{ text: `message-${position}`, type: "text" as const }],
                id: `message-${position}`,
                role: "agent" as const,
            };
            opened.database
                .insert(sessionMessages)
                .values({
                    isPartial: false,
                    messageId: message.id,
                    messageJson: JSON.stringify(message),
                    position,
                    role: message.role,
                    runId: "run-1",
                    sessionId: "session-1",
                    updatedAtMs: 1,
                })
                .run();
        }

        const first = sessionPruneToolResults(opened.database, { before: 100, limit: 2 });
        expect(first).toEqual({
            complete: false,
            cursor: { position: 1, sessionId: "session-1" },
            pruned: 0,
        });
        if (first.complete) throw new Error("Expected another page.");
        expect(
            sessionPruneToolResults(opened.database, {
                after: first.cursor,
                before: 100,
                limit: 2,
            }),
        ).toEqual({ complete: true, pruned: 0 });
    });
});

function toolResultMessage(id: string, output: string): AgentMessage {
    return {
        blocks: [
            {
                display: "Read a large file.",
                presentation: {
                    command: "read large-file.ts",
                    output: "p".repeat(4_000),
                    type: "exec_command",
                },
                providerToolCallId: "provider-call-1",
                rendered: [
                    { text: output, type: "text" },
                    { data: "base64-image", mediaType: "image/png", type: "image" },
                ],
                trustedUserEvidence: [{ text: "keep authorization evidence", type: "text" }],
                toolCallId: "call-1",
                toolName: "Read",
                type: "tool_result",
                vendor: { replay: "keep" },
            },
        ],
        id,
        role: "agent",
    };
}

function readMessage(
    database: SessionDatabase,
    table: "session_context_messages" | "session_messages",
): AgentMessage {
    const row = database.get<{ message_json: string }>(
        sql.raw(`SELECT message_json FROM ${table} WHERE session_id = 'session-1'`),
    );
    if (row === undefined) throw new Error(`Expected a row in ${table}.`);
    return JSON.parse(row.message_json) as AgentMessage;
}
