import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("HistoryModule durability", () => {
    it("marks the durable read tool transactional", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-commit-test");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                at: 123,
                blocks: [{ text: "Remember this.", type: "text" }],
                recordId: "history-record-1",
                role: "user",
            });
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<HistoryModule["tools"]>[1];
            const [tool] = history.tools(database.context, scope);
            const result = await tool!.execute(database.context, {}, {
                id: "call-history-1",
                providerCallId: "provider-history-1",
                kv: {},
            } as never);

            expect(tool!.durable).toBe(true);
            expect(tool!.transactional).toBe(true);
            expect(result).toMatchObject({
                agents: [
                    {
                        agent_id: "agent-a",
                        message_count: 1,
                        path: "agent-a",
                        status: "unknown",
                    },
                ],
                matched_messages: 1,
                returned_messages: 1,
                target: "agent-a",
                total_messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("lists the session tree and resolves a canonical path through the host seam", async () => {
        let resolvedTarget: string | undefined;
        const history = new HistoryModule({
            listAgents: (_ctx, requesterAgentId) => [
                {
                    agentId: requesterAgentId,
                    messageCount: 0,
                    path: "/root",
                    status: "working",
                },
                {
                    agentId: "agent-b",
                    description: "Audit worker",
                    messageCount: 1,
                    path: "/root/audit",
                    status: "finished",
                },
            ],
            resolveTarget: (_ctx, _requesterAgentId, requestedTarget) => {
                resolvedTarget = requestedTarget;
                return "agent-b";
            },
        });
        const database = moduleDatabase(history.migrations, "history-agent-tree-test");
        await database.ready;

        try {
            await history.record(database.context, "agent-b", {
                at: 123,
                blocks: [{ text: "Audit result.", type: "text" }],
                recordId: "history-record-b",
                role: "assistant",
            });
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<HistoryModule["tools"]>[1];
            const [tool] = history.tools(database.context, scope);
            const result = await tool!.execute(database.context, { target: "/root/audit" }, {
                id: "call-history-tree",
                providerCallId: "provider-history-tree",
                kv: {},
            } as never);

            expect(resolvedTarget).toBe("/root/audit");
            expect(result).toMatchObject({
                agents: [
                    {
                        agent_id: "agent-a",
                        path: "/root",
                        status: "working",
                    },
                    {
                        agent_id: "agent-b",
                        description: "Audit worker",
                        path: "/root/audit",
                        status: "finished",
                    },
                ],
                target: "agent-b",
                total_messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("treats a reused record ID as a conflict instead of a replay no-op", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-record-conflict-test");
        await database.ready;

        try {
            const message = {
                at: 123,
                blocks: [{ text: "Only once.", type: "text" as const }],
                recordId: "history-record-1",
                role: "user" as const,
            };
            await history.record(database.context, "agent-a", message);
            await expect(history.record(database.context, "agent-a", message)).rejects.toThrow();
            await expect(history.stats(database.context, "agent-a")).resolves.toMatchObject({
                messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("records a one-line tool display summary through the injected formatter", async () => {
        const displayInputs: unknown[] = [];
        const history = new HistoryModule({
            toolDisplay: (_ctx, input) => {
                displayInputs.push(input);
                return "Listed files.";
            },
        });
        const database = moduleDatabase(history.migrations, "history-tool-display-test");
        await database.ready;

        const values = new Map<string, unknown>();
        const scope = {
            agent: { id: "agent-a" },
            runKV: {
                delete: async () => undefined,
                read: async (_ctx: unknown, key: string) => values.get(key),
                write: async (_ctx: unknown, key: string, value: unknown) => {
                    values.set(key, value);
                },
            },
        } as never;

        try {
            await history.beforeToolCallTransact(database.context, scope, {
                arguments: "{}",
                callId: "call-display-1",
                name: "list_files",
                type: "tool_call",
            });
            await history.afterToolCallTransact(database.context, scope, {
                callId: "call-display-1",
                content: [{ text: "file.txt", type: "text" }],
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            const block = page.messages[0]?.message.blocks[0];
            expect(displayInputs).toEqual([
                {
                    callId: "call-display-1",
                    output: "file.txt",
                    toolName: "list_files",
                },
            ]);
            expect(block).toMatchObject({
                display: "Listed files.",
                output: "file.txt",
                type: "tool_result",
            });
        } finally {
            database.close();
        }
    });

    it("uses a bounded generic display when no formatter is configured", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-display-fallback-test");
        await database.ready;

        const values = new Map<string, unknown>();
        const scope = {
            agent: { id: "agent-a" },
            runKV: {
                delete: async () => undefined,
                read: async (_ctx: unknown, key: string) => values.get(key),
                write: async (_ctx: unknown, key: string, value: unknown) => {
                    values.set(key, value);
                },
            },
        } as never;

        try {
            await history.beforeToolCallTransact(database.context, scope, {
                arguments: "{}",
                callId: "call-display-2",
                name: "list_files",
                type: "tool_call",
            });
            await history.afterToolCallTransact(database.context, scope, {
                callId: "call-display-2",
                content: [{ text: "file.txt", type: "text" }],
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.blocks[0]).toMatchObject({
                display: "Tool list_files returned 8 characters.",
            });
        } finally {
            database.close();
        }
    });
});
