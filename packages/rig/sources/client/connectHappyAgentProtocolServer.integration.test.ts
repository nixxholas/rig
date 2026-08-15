import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
    type HappyAgentIntegrations,
} from "@slopus/happy-agent";
import { createRootContext, type RootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { connectHappyAgentProtocolServer } from "./connectHappyAgentProtocolServer.js";

const running = new Set<{
    readonly ctx: RootContext;
    readonly daemon: HappyAgentDaemon;
    readonly directory: string;
}>();

afterEach(async () => {
    await Promise.all(
        [...running].map(async ({ ctx, daemon, directory }) => {
            await daemon.close(ctx.named("test-cleanup")).catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("Rig client to Happy Agent daemon integration", () => {
    it("drives inference and SSE through the replacement Unix socket and survives restart", async () => {
        const first = await startTestDaemon();
        const connection = await connectHappyAgentProtocolServer({
            agentHome: first.daemon.agent.agentHome,
        });

        await expect(connection.client.health()).resolves.toMatchObject({
            healthy: true,
            protocolVersion: 0,
            ready: true,
            status: "ready",
        });
        const sessions = await connection.client.listSessions();
        expect(sessions.sessions).toHaveLength(1);
        const session = sessions.sessions[0];
        if (session === undefined) throw new Error("Happy Agent exposed no root session.");

        const submitted = await connection.client.submitMessage(session.id, {
            text: "Reply through the Rig protocol client.",
        });
        expect(submitted).toMatchObject({
            eventId: expect.any(String),
            runId: expect.any(String),
            sessionId: session.id,
        });
        const abort = new AbortController();
        const message = deferred<unknown>();
        const finished = deferred<unknown>();
        const watching = connection.client.watchSessionEvents({
            after: submitted.eventId,
            onEvent: (event) => {
                if (event.type === "agent_message" && event.data.runId === submitted.runId) {
                    message.resolve(event);
                }
                if (event.type === "run_finished" && event.data.runId === submitted.runId) {
                    finished.resolve(event);
                    abort.abort();
                }
            },
            sessionId: session.id,
            signal: abort.signal,
        });
        await expect(message.promise).resolves.toMatchObject({
            data: {
                message: {
                    blocks: [{ text: "Happy Agent replied through Rig.", type: "text" }],
                },
                runId: submitted.runId,
            },
            type: "agent_message",
        });
        await expect(finished.promise).resolves.toMatchObject({
            data: { runId: submitted.runId, stopReason: "stop" },
            type: "run_finished",
        });
        await watching;

        const events = await vi.waitFor(async () => {
            const page = await connection.client.getEvents(session.id);
            expect(page.events.length).toBeGreaterThanOrEqual(5);
            return page;
        });
        expect(events.events).toEqual(expect.any(Array));

        await expect(
            connection.client.broadcastMessage({
                sessionIds: [session.id],
                text: "Broadcast through Rig.",
            }),
        ).resolves.toMatchObject({
            submissions: [expect.objectContaining({ runId: expect.any(String) })],
        });

        const originalToken = connection.token;
        await first.daemon.close(first.ctx.named("restart"));
        running.delete(first);
        const restarted = await startTestDaemon(first.directory);
        const reconnected = await connectHappyAgentProtocolServer({
            agentHome: restarted.daemon.agent.agentHome,
        });
        expect(reconnected.token).toBe(originalToken);
        await expect(reconnected.client.listSessions()).resolves.toMatchObject({
            sessions: [expect.objectContaining({ id: session.id })],
        });
    });
});

async function startTestDaemon(existingDirectory?: string) {
    const directory = existingDirectory ?? (await createTestSocketDirectory());
    const agentHome = join(directory, "agent");
    const publicHome = join(directory, "public");
    const providers = new AgentProviders();
    providers.add("scripted", scriptedProvider(), "gym");
    const models: readonly AgentModel[] = [
        {
            defaultEffort: "medium",
            effortLevels: ["low", "medium", "high"],
            id: "scripted-model",
            name: "Scripted Model",
            providerId: "scripted",
        },
    ];
    const ctx = createRootContext() as unknown as RootContext;
    const daemon = await startHappyAgentDaemon(ctx as Parameters<typeof startHappyAgentDaemon>[0], {
        agentHome,
        integrations: unavailableIntegrations(),
        models,
        provider: "scripted",
        providers,
        publicHome,
        version: "integration-test",
    });
    const entry = { ctx, daemon, directory };
    running.add(entry);
    return entry;
}

function scriptedProvider() {
    return {
        inputTypes: ["text"],
        name: "scripted",
        outputTypes: ["text"],
        session: async (id: string) => ({
            id,
            compact: async () => {
                throw new Error("Compaction is unavailable in this integration test.");
            },
            destroy: () => undefined,
            run: () => {
                const events = [
                    { type: "text_start" },
                    { type: "text_delta", delta: "Happy Agent replied through Rig." },
                    { type: "text_end" },
                    {
                        type: "done",
                        state: "normal",
                        tokens: { input: 2, output: 6 },
                    },
                ] as const;
                return (async function* () {
                    yield* events;
                })();
            },
        }),
    } as never;
}

function unavailableIntegrations(): HappyAgentIntegrations {
    return {
        collaboration: {
            create: async (
                _ctx: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[0],
                _config: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[1],
                options: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[2],
            ) => ({ id: options.id }),
            config: async () => undefined,
            send: async () => undefined,
            wait: async () => {
                throw new Error("Collaboration waits are unavailable in this integration test.");
            },
        },
        happy: {
            notify: async () => ({ accepted: false }),
            setStatus: async () => ({ accepted: false }),
        },
        imageGeneration: {
            generate: async () => {
                throw new Error("Image generation is unavailable in this integration test.");
            },
        },
        mcp: {
            callTool: async () => {
                throw new Error("MCP is unavailable in this integration test.");
            },
            getPrompt: async () => {
                throw new Error("MCP is unavailable in this integration test.");
            },
            listPrompts: async () => ({ prompts: [] }),
            listResourceTemplates: async () => ({ resourceTemplates: [] }),
            listResources: async () => ({ resources: [] }),
            listServers: async () => ({ servers: [] }),
            listTools: async () => ({ tools: [] }),
            readResource: async () => {
                throw new Error("MCP is unavailable in this integration test.");
            },
        },
        scheduling: unavailableScheduler(),
        search: {
            fetch: async (
                _ctx: Parameters<HappyAgentIntegrations["search"]["fetch"]>[0],
                _agentId: Parameters<HappyAgentIntegrations["search"]["fetch"]>[1],
                input: Parameters<HappyAgentIntegrations["search"]["fetch"]>[2],
            ) => ({ content: "", truncated: false, url: input.url }),
            search: async (
                _ctx: Parameters<HappyAgentIntegrations["search"]["search"]>[0],
                _agentId: Parameters<HappyAgentIntegrations["search"]["search"]>[1],
                query: Parameters<HappyAgentIntegrations["search"]["search"]>[2],
            ) => ({ query: query.query, results: [] }),
        },
        slots: {
            publisher: async () => undefined,
            scopeResolver: async () => false,
        },
        userInput: {
            wait: async () => {
                throw new Error("User input is unavailable in this integration test.");
            },
        },
        workflows: unavailableWorkflowRuntime(),
        worklets: {
            invokeOperation: async () => {
                throw new Error("Worklets are unavailable in this integration test.");
            },
            readLogs: async () => ({ lines: [] }),
            status: async () => ({ name: "unavailable", status: "stopped" }),
        },
    } as unknown as HappyAgentIntegrations;
}

function unavailableScheduler(): HappyAgentIntegrations["scheduling"] {
    const unavailable = async () => {
        throw new Error("Scheduling is unavailable in this integration test.");
    };
    return {
        cancel: unavailable,
        reportDelivery: unavailable,
        schedule: unavailable,
        startWait: unavailable,
        wait: unavailable,
    };
}

function unavailableWorkflowRuntime(): HappyAgentIntegrations["workflows"] {
    const unavailable = async () => {
        throw new Error("Workflows are unavailable in this integration test.");
    };
    return {
        cancel: unavailable,
        launch: unavailable,
        resume: unavailable,
        wait: unavailable,
    };
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
