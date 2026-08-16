import {
    agentDatabaseRows,
    withAgentPermissionMode,
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
    type CollaborationAgentObservation,
    type CollaborationBroker,
    type CollaborationAgentSelection,
    type CollaborationModelCatalog,
    type CollaborationObligation,
    type CollaborationSpawnCapacity,
} from "../../sources/collaboration/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

class Broker implements CollaborationBroker {
    readonly configs = new Map<string, AgentConfig>();
    readonly sent: Array<{ readonly target: string; readonly id: string }> = [];
    readonly permissions: Array<{
        readonly actor: string;
        readonly target: string;
        readonly readOnly: boolean;
    }> = [];
    readonly permissionModes: Array<Parameters<CollaborationBroker["setReadOnly"]>[4]> = [];
    readonly interrupted: string[] = [];
    readonly createOptions: Array<Parameters<CollaborationBroker["create"]>[2]> = [];
    readonly selections = new Map<string, CollaborationAgentSelection>();
    sendAttempts = 0;
    waitResult: CollaborationObligation | undefined;
    database: AgentDatabase | undefined;
    createDepths: number[] = [];
    createAdmission: (() => void) | undefined;
    sendDepths: number[] = [];
    waitDepths: number[] = [];
    observations = new Map<string, CollaborationAgentObservation>();
    interruptResult: CollaborationAgentObservation | undefined;
    capacity: CollaborationSpawnCapacity = {
        canSpawn: true,
        depth: 0,
        maxDepth: 3,
        maxActive: 10,
        active: 0,
    };
    readonly capacities = new Map<string, CollaborationSpawnCapacity>();

    async create(
        _ctx: Parameters<CollaborationBroker["create"]>[0],
        config: AgentConfig,
        options: Parameters<CollaborationBroker["create"]>[2],
    ): Promise<{ readonly id: string }> {
        this.createDepths.push(this.#transactionDepth(_ctx));
        this.createAdmission?.();
        this.createOptions.push(structuredClone(options));
        this.selections.set(options.id, structuredClone(options.selection));
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

    async selection(
        _ctx: Parameters<CollaborationBroker["selection"]>[0],
        id: string,
    ): Promise<CollaborationAgentSelection | undefined> {
        const selection = this.selections.get(id);
        return selection === undefined ? undefined : structuredClone(selection);
    }

    async send(
        _ctx: Parameters<CollaborationBroker["send"]>[0],
        target: string,
        _message: Parameters<CollaborationBroker["send"]>[2],
        options: Parameters<CollaborationBroker["send"]>[3],
    ): Promise<void> {
        this.sendDepths.push(this.#transactionDepth(_ctx));
        this.sendAttempts += 1;
        if (!this.sent.some((sent) => sent.target === target && sent.id === options.id)) {
            this.sent.push({ target, id: options.id });
        }
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

    async interrupt(
        _ctx: Parameters<CollaborationBroker["interrupt"]>[0],
        _actingAgentId: string,
        targetAgentId: string,
    ): Promise<CollaborationAgentObservation> {
        this.interrupted.push(targetAgentId);
        const observation = this.interruptResult ?? {
            agentId: targetAgentId,
            runId: "run-1",
            version: 2,
            status: "aborted" as const,
            output: "The collaborator was interrupted.",
            updatedAt: 2,
        };
        this.observations.set(targetAgentId, observation);
        return structuredClone(observation);
    }

    async observe(
        _ctx: Parameters<CollaborationBroker["observe"]>[0],
        _actingAgentId: string,
        targetAgentId: string,
    ): Promise<CollaborationAgentObservation> {
        return structuredClone(
            this.observations.get(targetAgentId) ?? {
                agentId: targetAgentId,
                runId: "run-1",
                version: 1,
                status: "running",
                updatedAt: 1,
            },
        );
    }

    async waitForAgent(
        _ctx: Parameters<CollaborationBroker["waitForAgent"]>[0],
        _actingAgentId: string,
        targetAgentId: string,
        _timeoutMs: number,
    ): Promise<CollaborationAgentObservation> {
        return await this.observe(_ctx, _actingAgentId, targetAgentId);
    }

    async setReadOnly(
        _ctx: Parameters<CollaborationBroker["setReadOnly"]>[0],
        actingAgentId: string,
        targetAgentId: string,
        readOnly: boolean,
        permissionMode: Parameters<CollaborationBroker["setReadOnly"]>[4],
    ): Promise<void> {
        this.permissions.push({ actor: actingAgentId, target: targetAgentId, readOnly });
        this.permissionModes.push(permissionMode);
    }

    async spawnCapacity(
        _ctx: Parameters<CollaborationBroker["spawnCapacity"]>[0],
        actingAgentId: string,
    ) {
        return this.capacities.get(actingAgentId) ?? this.capacity;
    }

    #transactionDepth(ctx: Parameters<CollaborationBroker["wait"]>[0]): number {
        return this.database !== undefined && ctx.db !== this.database ? 1 : 0;
    }
}

function setup(
    name: string,
    listener?: ConstructorParameters<typeof CollaborationModule>[0]["listener"],
    modelCatalog: CollaborationModelCatalog | null = {
        availableModels: [
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "model",
                name: "Test model",
                providerId: "provider",
                serviceTiers: ["priority"],
            },
        ],
        disabledProviders: [],
    },
    maxOutputCharacters = 8_000,
    brokerOverride?: Broker,
) {
    const broker = brokerOverride ?? new Broker();
    let eventSequence = 0;
    const collaboration = new CollaborationModule({
        broker,
        ...(modelCatalog === null ? {} : { modelCatalog }),
        eventIdFactory: () => `event${++eventSequence}`,
        clock: () => 1_000 + eventSequence,
        maxOutputCharacters,
        ...(listener === undefined ? {} : { listener }),
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
    return await collaboration.createAgent(ctx, id, {
        id,
        config: {},
        model: "model",
        effort: "medium",
        provider: "provider",
    });
}

describe("CollaborationModule", () => {
    it("keeps the immutable base schema and applies forward collaboration migrations", async () => {
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
                "003-collaboration-run-state",
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
                {
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                    role: "reviewer",
                },
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
            expect(broker.createDepths).toEqual([0, 0]);
            expect(broker.sendDepths).toEqual([0, 0]);
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
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "child",
                    parentId: "owner",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
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
            const interrupt = byName.get("interrupt_agent")!;
            expect(
                interrupt.shouldReviewInAutoMode({ targetAgentId: "owner" }, database.context),
            ).toBe(true);
            expect(
                interrupt.describeAutoPermissionAction?.(
                    { targetAgentId: "owner" },
                    database.context,
                ),
            ).toContain("interrupting collaborator");
            expect(byName.get("create_agent")?.transactional).not.toBe(true);
            expect(byName.get("send_agent_message")?.transactional).not.toBe(true);
            expect(byName.get("reply_to_agent_message")?.transactional).not.toBe(true);
            expect(byName.get("wait_for_reply")?.transactional).not.toBe(true);
            expect(collaborationAgentSchema).toBeDefined();
        } finally {
            database.close();
        }
    });

    it("keeps collaboration available without a host model catalog", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-no-catalog-test",
            undefined,
            null,
        );
        await ready;
        try {
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const create = tools.find(({ name }) => name === "create_agent")!;
            expect(create.description).toContain("Model catalog unavailable");
            const created = await create.execute(
                database.context,
                {
                    config: {},
                    model: "host-selected-model",
                    effort: "medium",
                    provider: "host-provider",
                },
                toolCall("owner", [], [], broker),
            );
            expect(created.id).toBe("owner");
        } finally {
            database.close();
        }
    });

    it("truncates creation guidance and observations at the minimum output budget", async () => {
        const { collaboration, database, ready } = setup(
            "collaboration-output-budget-test",
            undefined,
            null,
            256,
        );
        await ready;
        try {
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const create = tools.find(({ name }) => name === "create_agent")!;
            expect(create.description!.length).toBeLessThanOrEqual(256);
            expect(create.description).toContain("truncated");
            const rendered = collaboration.formatAgentObservationForModel({
                agentId: "owner",
                runId: "run-1",
                version: 1,
                status: "completed",
                path: "p".repeat(512),
                updatedAt: 1,
            });
            expect(rendered.length).toBeLessThanOrEqual(256);
            expect(rendered).toContain("truncated");
        } finally {
            database.close();
        }
    });

    it("returns bounded validation errors for primitive wait inputs", async () => {
        const { collaboration, database, ready } = setup("collaboration-wait-input-test");
        await ready;
        try {
            await expect(
                collaboration.waitForReply(database.context, "owner", null as never),
            ).rejects.toThrow("Invalid collaboration wait");
        } finally {
            database.close();
        }
    });

    it("reconciles stable broker effects after catalog finalization rolls back", async () => {
        let rejectCreate = true;
        let rejectSend = false;
        const { broker, collaboration, database, ready } = setup("collaboration-retry-contract", {
            onEventTransactional: async (_ctx, event) => {
                if (rejectCreate && event.type === "agent_created") {
                    throw new Error("reject agent finalization");
                }
                if (rejectSend && event.type === "message_sent") {
                    throw new Error("reject message finalization");
                }
            },
        });
        await ready;
        try {
            await expect(createRoot(collaboration, database.context)).rejects.toThrow(
                "reject agent finalization",
            );
            rejectCreate = false;
            await expect(createRoot(collaboration, database.context)).resolves.toMatchObject({
                id: "owner",
            });
            expect(broker.createDepths).toEqual([0]);

            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            rejectSend = true;
            const input = {
                toAgentId: "child",
                text: "Retry this delivery",
                messageId: "message-stable",
            } as const;
            await expect(
                collaboration.sendMessage(database.context, "owner", input),
            ).rejects.toThrow("reject message finalization");
            rejectSend = false;
            await expect(
                collaboration.sendMessage(database.context, "owner", input),
            ).resolves.toMatchObject({ message: { id: "message-stable" } });
            expect(broker.sendAttempts).toBe(2);
            expect(broker.sent).toEqual([{ target: "child", id: "message-stable" }]);
            expect(broker.sendDepths).toEqual([0, 0]);
        } finally {
            database.close();
        }
    });

    it("passes model selection, context forking, and read-only creation to the host broker", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-selection-and-fork-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "high",
                provider: "provider",
                serviceTier: "priority",
                context: "parent",
                forkTurns: "all",
                readOnly: true,
            });

            expect(broker.createOptions.at(-1)).toMatchObject({
                id: "child",
                parent: "owner",
                context: "parent",
                forkTurns: "all",
                readOnly: true,
                selection: {
                    model: "model",
                    effort: "high",
                    provider: "provider",
                    serviceTier: "priority",
                },
            });
        } finally {
            database.close();
        }
    });

    it("rejects unavailable model selection before invoking the broker", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-model-validation-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "child",
                    config: {},
                    model: "missing-model",
                    effort: "medium",
                    provider: "provider",
                }),
            ).rejects.toThrow('Model "missing-model" is not available');
            expect(broker.createOptions).toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("requires a provider for ambiguous model IDs and ignores disabled routes", async () => {
        const catalog: CollaborationModelCatalog = {
            availableModels: [
                {
                    defaultEffort: "low",
                    effortLevels: ["low"],
                    id: "duplicate",
                    name: "Provider A model",
                    providerId: "provider-a",
                },
                {
                    defaultEffort: "low",
                    effortLevels: ["low"],
                    id: "duplicate",
                    name: "Provider B model",
                    providerId: "provider-b",
                },
                {
                    defaultEffort: "low",
                    effortLevels: ["low"],
                    id: "disabled-model",
                    name: "Disabled model",
                    providerId: "disabled-provider",
                },
                {
                    defaultEffort: "low",
                    effortLevels: ["low"],
                    id: "disabled-model",
                    name: "Active model",
                    providerId: "provider-a",
                },
            ],
            disabledProviders: [{ id: "disabled-provider", reason: "not_enabled" }],
        };
        const { collaboration, database, ready } = setup(
            "collaboration-provider-selection-test",
            undefined,
            catalog,
        );
        await ready;
        try {
            await collaboration.createAgent(database.context, "owner", {
                id: "owner",
                config: {},
                model: "duplicate",
                effort: "low",
                provider: "provider-a",
            });
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "ambiguouschild",
                    config: {},
                    model: "duplicate",
                    effort: "low",
                }),
            ).rejects.toThrow("Provider is required");
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "disabledchild",
                    config: {},
                    model: "disabled-model",
                    effort: "low",
                }),
            ).rejects.toThrow("Provider is required");
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "activechild",
                    config: {},
                    model: "disabled-model",
                    effort: "low",
                    provider: "provider-a",
                }),
            ).resolves.toMatchObject({ id: "activechild" });
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "disabledproviderchild",
                    config: {},
                    model: "disabled-model",
                    effort: "low",
                    provider: "disabled-provider",
                }),
            ).rejects.toThrow("disabled");
        } finally {
            database.close();
        }
    });

    it("switches permission mode for messages and stops a running collaborator", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-interrupt-permission-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            await collaboration.sendMessage(database.context, "owner", {
                messageId: "permission-message",
                toAgentId: "child",
                text: "Inspect this.",
                readOnly: true,
            });
            await collaboration.sendMessage(database.context, "owner", {
                messageId: "restore-permission-message",
                toAgentId: "child",
                text: "Now make the change.",
                readOnly: false,
            });
            expect(broker.permissions).toEqual([
                { actor: "owner", target: "child", readOnly: true },
                { actor: "owner", target: "child", readOnly: false },
            ]);

            broker.observations.set("child", {
                agentId: "child",
                runId: "run-1",
                version: 1,
                status: "running",
                output: "Working.",
                updatedAt: 1,
            });
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const interrupt = tools.find(({ name }) => name === "interrupt_agent")!;
            const result = await interrupt.execute(
                database.context,
                { targetAgentId: "child" },
                toolCall("interrupt-call", [], [], broker),
            );
            expect(result).toMatchObject({
                agentId: "child",
                status: "aborted",
            });
            expect(broker.interrupted).toEqual(["child"]);
        } finally {
            database.close();
        }
    });

    it("cannot widen a collaborator from a read-only sender", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-read-only-monotonic-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            const readOnlyContext = withAgentPermissionMode(database.context, "read_only");
            await collaboration.createAgent(readOnlyContext, "owner", {
                id: "readonlychild",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
                readOnly: false,
            });
            const request = await collaboration.sendMessage(readOnlyContext, "owner", {
                messageId: "readonly-permission",
                toAgentId: "readonlychild",
                text: "Remain restricted.",
                readOnly: false,
                expectReply: true,
            });
            await collaboration.replyMessage(readOnlyContext, "readonlychild", {
                toAgentId: "owner",
                text: "Still restricted.",
                replyTo: request.obligation!.id,
                readOnly: false,
            });
            expect(broker.createOptions.at(-1)?.readOnly).toBe(true);
            expect(broker.permissions.at(-1)?.readOnly).toBe(true);
            expect(broker.permissionModes.at(-1)).toBe("read_only");
        } finally {
            database.close();
        }
    });

    it("rejects stale and reordered collaborator observations", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-stale-observation-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const wait = tools.find(({ name }) => name === "wait_for_reply")!;
            broker.observations.set("child", {
                agentId: "child",
                runId: "run-2",
                version: 2,
                status: "completed",
                updatedAt: 20,
            });
            await wait.execute(
                database.context,
                { agentId: "child" },
                toolCall("wait-new", [], [], broker),
            );
            broker.observations.set("child", {
                agentId: "child",
                runId: "run-2",
                version: 1,
                status: "running",
                updatedAt: 10,
            });
            await expect(
                wait.execute(
                    database.context,
                    { agentId: "child" },
                    toolCall("wait-old", [], [], broker),
                ),
            ).rejects.toThrow("observation for");
            broker.observations.set("child", {
                agentId: "child",
                runId: "run-2",
                version: 2,
                status: "completed",
                updatedAt: 19,
            });
            await expect(
                wait.execute(
                    database.context,
                    { agentId: "child" },
                    toolCall("wait-old-timestamp", [], [], broker),
                ),
            ).rejects.toThrow("observation for");
            broker.observations.set("child", {
                agentId: "child",
                runId: "run-2",
                version: 2,
                status: "running",
            });
            await expect(
                wait.execute(
                    database.context,
                    { agentId: "child" },
                    toolCall("wait-same-version", [], [], broker),
                ),
            ).rejects.toThrow("observation for");
            broker.observations.set("child", {
                agentId: "child",
                runId: "different-run",
                version: 2,
                status: "error",
                updatedAt: 21,
            });
            await expect(
                wait.execute(
                    database.context,
                    { agentId: "child" },
                    toolCall("wait-reordered", [], [], broker),
                ),
            ).rejects.toThrow("observation for");
        } finally {
            database.close();
        }
    });

    it("requires interruption authorization and a terminal newer result", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-interrupt-postcondition-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await createRoot(collaboration, database.context, "other");
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            broker.observations.set("child", {
                agentId: "child",
                runId: "run-1",
                version: 1,
                status: "running",
                updatedAt: 1,
            });
            await expect(
                collaboration.interruptAgent(database.context, "other", "child"),
            ).rejects.toThrow("not authorized");

            broker.interruptResult = {
                agentId: "child",
                runId: "run-1",
                version: 2,
                status: "running",
                updatedAt: 2,
            };
            await expect(
                collaboration.interruptAgent(database.context, "owner", "child"),
            ).rejects.toThrow("did not stop");
            broker.interruptResult = {
                agentId: "child",
                runId: "run-1",
                version: 1,
                status: "aborted",
                updatedAt: 1,
            };
            await expect(
                collaboration.interruptAgent(database.context, "owner", "child"),
            ).rejects.toThrow("stale interruption");
        } finally {
            database.close();
        }
    });

    it("returns terminal status and bounded output when waiting on a collaborator run", async () => {
        const { broker, collaboration, database, ready } = setup("collaboration-agent-wait-test");
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            broker.observations.set("child", {
                agentId: "child",
                runId: "run-1",
                version: 2,
                status: "completed",
                output: "Review complete.",
                updatedAt: 2,
            });
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const wait = tools.find(({ name }) => name === "wait_for_reply")!;
            const result = await wait.execute(
                database.context,
                { agentId: "child", timeoutMs: 0 },
                toolCall("agent-wait-call", [], [], broker),
            );
            expect(result).toEqual({
                agentId: "child",
                runId: "run-1",
                version: 2,
                status: "completed",
                output: "Review complete.",
                updatedAt: 2,
            });
            const rendered = collaboration.formatAgentObservationForModel({
                agentId: "child",
                runId: "run-1",
                version: 2,
                status: "completed",
                output: "x".repeat(20_000),
                updatedAt: 2,
            });
            expect(rendered.length).toBeLessThanOrEqual(8_000);
            expect(rendered).toContain("[output truncated]");
        } finally {
            database.close();
        }
    });

    it("surfaces spawn limits and refuses a spawn at the host-reported limit", async () => {
        const { broker, collaboration, database, ready } = setup("collaboration-spawn-limit-test");
        await ready;
        try {
            await createRoot(collaboration, database.context);
            broker.capacity = {
                canSpawn: false,
                depth: 3,
                maxDepth: 3,
                maxActive: 10,
                active: 3,
            };
            const tools = await collaboration.tools(database.context, {
                agent: { id: "owner" },
            } as never);
            const create = tools.find(({ name }) => name === "create_agent")!;
            expect(create.description).toContain("Spawning is currently unavailable");
            await expect(
                create.execute(
                    database.context,
                    {
                        config: {},
                        model: "model",
                        effort: "medium",
                        provider: "provider",
                    },
                    toolCall("blockedcreate", [], [], broker),
                ),
            ).rejects.toThrow("maximum subagent depth");
        } finally {
            database.close();
        }
    });

    it("checks capacity for the requested parent and at the create boundary", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-parent-capacity-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            await collaboration.createAgent(database.context, "owner", {
                id: "child",
                config: {},
                model: "model",
                effort: "medium",
                provider: "provider",
            });
            broker.capacities.set("child", {
                canSpawn: false,
                depth: 3,
                maxDepth: 3,
                maxActive: 10,
                active: 3,
            });
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "grandchild",
                    parentId: "child",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                }),
            ).rejects.toThrow("maximum subagent depth");

            broker.capacity = {
                canSpawn: true,
                depth: 0,
                maxDepth: 3,
                maxActive: 2,
                active: 2,
            };
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "anotherchild",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                }),
            ).rejects.toThrow("inconsistent active capacity");
        } finally {
            database.close();
        }
    });

    it("lets the broker reject a second create after its capacity snapshot goes stale", async () => {
        const { broker, collaboration, database, ready } = setup(
            "collaboration-concurrent-capacity-test",
        );
        await ready;
        try {
            await createRoot(collaboration, database.context);
            let admitted = 0;
            broker.capacity = {
                canSpawn: true,
                depth: 0,
                maxDepth: 3,
                maxActive: 1,
                active: 0,
            };
            broker.createAdmission = () => {
                if (admitted >= 1) throw new Error("atomic create capacity exhausted");
                admitted += 1;
            };
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "concurrentone",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                }),
            ).resolves.toMatchObject({ id: "concurrentone" });
            await expect(
                collaboration.createAgent(database.context, "owner", {
                    id: "concurrenttwo",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                }),
            ).rejects.toThrow("atomic create capacity exhausted");
            expect(admitted).toBe(1);
        } finally {
            database.close();
        }
    });

    it("lets the broker enforce capacity across concurrent creates", async () => {
        const broker = new Broker();
        const left = setup(
            "collaboration-concurrent-capacity-left",
            undefined,
            undefined,
            8_000,
            broker,
        );
        const right = setup(
            "collaboration-concurrent-capacity-right",
            undefined,
            undefined,
            8_000,
            broker,
        );
        await Promise.all([left.ready, right.ready]);
        try {
            await createRoot(left.collaboration, left.database.context);
            await createRoot(right.collaboration, right.database.context);
            let admitted = 0;
            broker.capacity = {
                canSpawn: true,
                depth: 0,
                maxDepth: 3,
                maxActive: 1,
                active: 0,
            };
            broker.createAdmission = () => {
                if (admitted >= 1) throw new Error("atomic concurrent capacity exhausted");
                admitted += 1;
            };
            const results = await Promise.allSettled([
                left.collaboration.createAgent(left.database.context, "owner", {
                    id: "concurrentleft",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                }),
                right.collaboration.createAgent(right.database.context, "owner", {
                    id: "concurrentright",
                    config: {},
                    model: "model",
                    effort: "medium",
                    provider: "provider",
                }),
            ]);
            expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
            expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
            const rejected = results.find(({ status }) => status === "rejected");
            expect(rejected?.status).toBe("rejected");
            if (rejected?.status === "rejected") {
                expect(rejected.reason).toHaveProperty(
                    "message",
                    "atomic concurrent capacity exhausted",
                );
            }
            expect(admitted).toBe(1);
        } finally {
            left.database.close();
            right.database.close();
        }
    });
});
