import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@steve.kite/stdlib";

import type { AgentMessage } from "../../../agent/types.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { sessionContextMessages, sessionMessages, sessions } from "../../database/schema.js";
import { sessionPruneToolResults } from "../sessionPruneToolResults.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

describe("sessionPruneToolResults", () => {
    let opened: Awaited<Awaited<ReturnType<typeof openSessionDatabase>>> | undefined;
    let directory: string | undefined;

    afterEach(async () => {
        if (opened !== undefined) await opened.database.close(opened.ctx);
        opened = undefined;
        if (directory !== undefined) await rm(directory, { force: true, recursive: true });
        directory = undefined;
    });

    it("removes only stale durable-history payloads and leaves provider context untouched", async () => {
        directory = await mkdtemp(join(tmpdir(), "rig-tool-result-retention-"));
        const path = join(directory, "sessions.sqlite");
        await createSessionDatabaseFixture(path);
        opened = await openSessionDatabase(createTestRootContext(), path);
        const message = toolResultMessage("result-1", "large-output");
        await opened.ctx.tx
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
        await opened.ctx.tx
            .insert(sessionContextMessages)
            .values({
                messageId: message.id,
                messageJson: JSON.stringify(message),
                position: 0,
                role: message.role,
                sessionId: "session-1",
            })
            .run();

        await opened.ctx.tx.update(sessions).set({ lastMessageAtMs: 150, updatedAtMs: 1 }).run();
        expect((await sessionPruneToolResults(opened.ctx, { before: 100, limit: 10 })).pruned).toBe(
            1,
        );

        await opened.ctx.tx.update(sessions).set({ lastMessageAtMs: 1, updatedAtMs: 150 }).run();
        expect((await sessionPruneToolResults(opened.ctx, { before: 100, limit: 10 })).pruned).toBe(
            0,
        );

        await opened.ctx.tx
            .update(sessions)
            .set({ lastMessageAtMs: 1, status: "running", updatedAtMs: 1 })
            .run();
        expect((await sessionPruneToolResults(opened.ctx, { before: 100, limit: 10 })).pruned).toBe(
            0,
        );

        await opened.ctx.tx.update(sessions).set({ status: "idle" }).run();
        expect((await sessionPruneToolResults(opened.ctx, { before: 100, limit: 10 })).pruned).toBe(
            1,
        );

        const history = await readMessage(opened.ctx, "session_messages");
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
        expect(block.presentation.output).toMatch(/^HEAD_/u);
        expect(block.presentation.output).toContain("truncated");
        expect(block.presentation.output).toMatch(/_TAIL$/u);
        expect(await readMessage(opened.ctx, "session_context_messages")).toEqual(message);
        expect(
            await opened.ctx.tx.get<{ message_updated: number; session_updated: number }>(sql`
                SELECT
                    message.updated_at_ms AS message_updated,
                    session.updated_at_ms AS session_updated
                FROM session_messages AS message
                JOIN sessions AS session ON session.id = message.session_id
                WHERE message.session_id = 'session-1'
            `),
        ).toEqual({ message_updated: 1, session_updated: 1 });
        expect((await sessionPruneToolResults(opened.ctx, { before: 100, limit: 10 })).pruned).toBe(
            0,
        );
    });

    it("does not paginate through messages that cannot be changed", async () => {
        directory = await mkdtemp(join(tmpdir(), "rig-tool-result-retention-page-"));
        const path = join(directory, "sessions.sqlite");
        await createSessionDatabaseFixture(path);
        opened = await openSessionDatabase(createTestRootContext(), path);
        for (let position = 0; position < 3; position += 1) {
            const message = {
                blocks: [{ text: `message-${position}`, type: "text" as const }],
                id: `message-${position}`,
                role: "agent" as const,
            };
            await opened.ctx.tx
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

        expect(await sessionPruneToolResults(opened.ctx, { before: 100, limit: 2 })).toEqual({
            complete: true,
            pruned: 0,
        });
    });
});

function toolResultMessage(id: string, output: string): AgentMessage {
    return {
        blocks: [
            {
                display: "Read a large file.",
                presentation: {
                    command: "read large-file.ts",
                    output: `HEAD_${"p".repeat(4_000)}_TAIL`,
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

async function readMessage(
    ctx: Context,
    table: "session_context_messages" | "session_messages",
): Promise<AgentMessage> {
    const row = await ctx.tx.get<{ message_json: string }>(
        sql.raw(`SELECT message_json FROM ${table} WHERE session_id = 'session-1'`),
    );
    if (row === undefined) throw new Error(`Expected a row in ${table}.`);
    return JSON.parse(row.message_json) as AgentMessage;
}
