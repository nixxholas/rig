import {
    agentDatabaseRows,
    type AgentConfig,
    type AgentDatabase,
    type AgentToolCall,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    CollaborationModule,
    collaborationAgentSchema,
    type CollaborationAgent,
    type CollaborationBroker,
    type CollaborationObligation,
} from "../../sources/collaboration/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

class Broker implements CollaborationBroker {
    readonly configs = new Map<string, AgentConfig>();
    readonly sent: Array<{ readonly target: string; readonly id: string }> = [];
    waitResult: CollaborationObligation | undefined;
    database: AgentDatabase | undefined;
    createDepths: number[] = [];
    sendDepths: number[] = [];
    waitDepths: number[] = [];

    async create(
        _ctx: Parameters<CollaborationBroker["create"]>[0],
        config: AgentConfig,
        options: Parameters<CollaborationBroker["create"]>[2],
    ): Promise<{ readonly id: string }> {
        this.createDepths.push(this.#transactionDepth(_ctx));
        this.configs.set(options.id, structuredClone(config));
        return { id: options.id };
    }

    async config(
        _ctx: Parameters<CollaborationBroker["config"]>[0],
        id: string,
    ): Promise<AgentConfig | undefined> {
        const config = this.configs.get(id);
        return config === undefined ? undefined : structuredClone(config);
    }

    async send(
        _ctx: Parameters<CollaborationBroker["send"]>[0],
        target: string,
        _message: Parameters<CollaborationBroker["send"]>[2],
        options: Parameters<CollaborationBroker["send"]>[3],
    ): Promise<void> {
        this.sendDepths.push(this.#transactionDepth(_ctx));
        this.sent.push({ target, id: options.id });
    }

    async wait(
        _ctx: Parameters<CollaborationBroker["wait"]>[0],
        _actingAgentId: string,
        obligationId: string,
    ): Promise<CollaborationObligation> {
        this.waitDepths.push(this.#transactionDepth(_ctx));
        if (this.waitResult?.id !== obligationId) throw new Error("missing wait result");
        return structuredClone(this.waitResult);
    }

    #transactionDepth(ctx: Parameters<CollaborationBroker["wait"]>[0]): number {
        return this.database !== undefined && ctx.db !== this.database ? 1 : 0;
    }
}

function setup(name: string) {
    const broker = new Broker();
    let obligationSequence = 0;
    let eventSequence = 0;
    const collaboration = new CollaborationModule({
        broker,
        obligationIdFactory: () => `obligation${++obligationSequence}`,
        eventIdFactory: () => `event${++eventSequence}`,
        clock: () => 1_000 + eventSequence,
    });
    const database = moduleDatabase([], name);
    broker.database = database.database;
    const ready = collaboration.migrations.reduce(async (previous, [, migrate]) => {
        await previous;
        await migrate(database.context, database.database);
    }, Promise.resolve());
    return {
        broker,
        collaboration,
        database,
        ready,
    };
}

function toolCall<Result>(
    id: string,
    commitDepths: number[],
    committed: unknown[],
    broker: Broker,
): AgentToolCall<any> {
    return {
        id,
        providerCallId: `provider-${id}`,
        kv: {} as never,
        commit: async (_ctx, result: Result) => {
            commitDepths.push(broker.database !== undefined && _ctx.db !== broker.database ? 1 : 0);
            committed.push(structuredClone(result));
            return result;
        },
    } as AgentToolCall<any>;
}

async function createRoot(
    collaboration: CollaborationModule,
    ctx: ReturnType<typeof moduleDatabase>["context"],
    id = "owner",
): Promise<CollaborationAgent> {
    return await collaboration.createAgent(ctx, id, { id, config: {} });
}

describe("CollaborationModule", () => {
    it("keeps only the forward migration that removes the obsolete receipt table", async () => {
        const { collaboration, database, ready } = setup("collaboration-migration-test");
        await ready;
        try {
            const tables = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name LIKE 'happy_collaboration_%'
                    ORDER BY name`,
            );
            expect(tables.map(({ name }) => name)).toEqual([
                "happy_collaboration_agents",
                "happy_collaboration_messages",
                "happy_collaboration_obligations",
            ]);
            expect(collaboration.migrations.map(([id]) => id)).toEqual([
                "001-collaboration",
                "002-drop-collaboration-receipts",
            ]);
        } finally {
            database.close();
        }
    });

    it("uses framework transactions for mutations and settles waits outside the broker call", async () => {
        const { broker, collaboration, database, ready } = setup("collaboration-tool-commit-test");
        await ready;
        try {
            await createRoot(collaboration, database.context);
            const commitDepths: number[] = [];
            const committed: unknown[] = [];
            const ownerTools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const create = ownerTools.find(({ name }) => name === "create_agent")!;
            const send = ownerTools.find(({ name }) => name === "send_agent_message")!;
            const wait = ownerTools.find(({ name }) => name === "wait_for_reply")!;

            const child = await create.execute(
                database.context,
                { config: {}, role: "reviewer" },
                toolCall("childcallid", commitDepths, committed, broker),
            );
            expect(child.id).toBe("childcallid");

            const request = await send.execute(
                database.context,
                {
                    toAgentId: child.id,
                    text: "Please review this.",
                    expectReply: true,
                },
                toolCall("messagecallid", commitDepths, committed, broker),
            );
            expect(request.message.id).toBe("messagecallid");
            expect(broker.sent.at(-1)).toEqual({
                target: child.id,
                id: "messagecallid",
            });

            const childTools = await collaboration.tools(database.context, {
                agent: { id: child.id },
            } as never);
            const reply = childTools.find(({ name }) => name === "reply_to_agent_message")!;
            const answered = await reply.execute(
                database.context,
                {
                    toAgentId: "owner",
                    text: "Done.",
                    replyTo: request.obligation!.id,
                },
                toolCall("replycallid", commitDepths, committed, broker),
            );
            expect(answered.message.id).toBe("replycallid");
            expect(answered.obligation?.status).toBe("answered");

            broker.waitResult = answered.obligation;
            const waited = await wait.execute(
                database.context,
                { obligationId: request.obligation!.id },
                toolCall("waitcallid", commitDepths, committed, broker),
            );
            expect(waited.status).toBe("answered");

            expect(commitDepths).toEqual([]);
            expect(committed).toEqual([]);
            expect(broker.createDepths).toEqual([1, 1]);
            expect(broker.sendDepths).toEqual([1, 1]);
            expect(broker.waitDepths).toEqual([0]);
        } finally {
            database.close();
        }
    });

    it("treats reused public identities as conflicts instead of replaying old results", async () => {
        const { broker, collaboration, database, ready } = setup("collaboration-conflict-test");
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                parentId: "owner",
                config: {},
            });
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "child",
                    parentId: "owner",
                    config: {},
                }),
            ).rejects.toThrow('Collaborator "child" already exists.');

            const input = {
                messageId: "message",
                toAgentId: "child",
                text: "Once.",
            } as const;
            await collaboration.sendMessage(database.context, "owner", input);
            await expect(
                collaboration.sendMessage(database.context, "owner", input),
            ).rejects.toThrow('Message "message" already exists.');
            expect(broker.sent).toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("keeps internal identities out of model inputs while marking tool durability explicitly", async () => {
        const { collaboration, database, ready } = setup("collaboration-tool-schema-test");
        await ready;
        try {
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const byName = new Map(tools.map((tool) => [tool.name, tool]));
            const properties = (name: string): Record<string, unknown> => {
                const parameters = byName.get(name)?.parameters as
                    | { readonly properties?: Record<string, unknown> }
                    | undefined;
                return parameters?.properties ?? {};
            };

            expect(properties("create_agent")).not.toHaveProperty("id");
            expect(properties("send_agent_message")).not.toHaveProperty("messageId");
            expect(properties("reply_to_agent_message")).not.toHaveProperty("messageId");
            expect(byName.get("create_agent")?.durable).toBe(true);
            expect(byName.get("list_agents")?.durable).toBe(true);
            expect(byName.get("send_agent_message")?.durable).toBe(true);
            expect(byName.get("reply_to_agent_message")?.durable).toBe(true);
            expect(byName.get("wait_for_reply")?.durable).toBe(false);
            expect(byName.get("create_agent")?.transactional).toBe(true);
            expect(byName.get("send_agent_message")?.transactional).toBe(true);
            expect(byName.get("reply_to_agent_message")?.transactional).toBe(true);
            expect(byName.get("wait_for_reply")?.transactional).not.toBe(true);
            expect(collaborationAgentSchema).toBeDefined();
        } finally {
            database.close();
        }
    });
});
