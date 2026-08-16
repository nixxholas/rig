import { rm } from "node:fs/promises";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import {
    AgentProviders,
    loadHappyAgentConfiguration,
    startAgentHttpServer,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
    type HappyAgentIntegrations,
} from "@slopus/happy-agent";
import { createRootContext, type RootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import type { EventId } from "../protocol/EventId.js";
import { connectHappyAgentProtocolServer } from "./connectHappyAgentProtocolServer.js";

const running = new Set<{
    readonly ctx: RootContext;
    readonly daemon: HappyAgentDaemon;
    readonly directory: string;
}>();
const childDaemons = new Set<ChildProcess>();

afterEach(async () => {
    for (const child of childDaemons) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(
        [...childDaemons].map(async (child) => {
            if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
        }),
    );
    childDaemons.clear();
    await Promise.all(
        [...running].map(async ({ ctx, daemon, directory }) => {
            await daemon.close(ctx.named("test-cleanup")).catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("Rig client to Happy Agent daemon integration", () => {
    it("exposes authenticated starting health before the Agent System is ready", async () => {
        const directory = await createTestSocketDirectory();
        const configuration = await loadHappyAgentConfiguration(join(directory, ".happy"));
        const ctx = createRootContext() as unknown as RootContext;
        const http = await startAgentHttpServer({
            agentConfiguration: configuration,
            ctx: ctx.named("starting-http"),
            version: "integration-test",
        });
        try {
            const connection = await connectHappyAgentProtocolServer({
                agentHome: configuration.paths.agentHome,
            });
            await expect(connection.client.health()).resolves.toMatchObject({
                healthy: true,
                ready: false,
                status: "starting",
            });
            await expect(connection.client.listSessions()).rejects.toMatchObject({
                statusCode: 503,
            });
        } finally {
            await http.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("drives inference and SSE through the replacement Unix socket and survives restart", async () => {
        const first = await startTestDaemon();
        const connection = await connectHappyAgentProtocolServer({
            agentHome: first.daemon.configuration.paths.agentHome,
        });

        await expect(connection.client.health()).resolves.toMatchObject({
            healthy: true,
            protocolVersion: 17,
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
        let finishedCursor: string | undefined;
        const providerEventTypes: string[] = [];
        const rigEventTypes: string[] = [];
        const watching = connection.client.watchSessionEvents({
            after: submitted.eventId,
            onEvent: (event) => {
                if (event.type === "agent_event") {
                    rigEventTypes.push(event.data.event.type);
                    if (event.data.providerEvent !== undefined) {
                        providerEventTypes.push(event.data.providerEvent.type);
                    }
                }
                if (event.type === "provider_event") {
                    providerEventTypes.push(event.data.event.type);
                }
                if (event.type === "agent_message" && event.data.runId === submitted.runId) {
                    message.resolve(event);
                }
                if (event.type === "run_finished" && event.data.runId === submitted.runId) {
                    finishedCursor = event.id;
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
                    blocks: expect.arrayContaining([
                        { text: "Happy Agent replied through Rig.", type: "text" },
                    ]),
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
        expect(providerEventTypes).toEqual([
            "block_start",
            "reasoning_start",
            "reasoning_delta",
            "reasoning_end",
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "toolcall_result_start",
            "toolcall_result_delta",
            "toolcall_result_end",
            "block_stop",
            "done",
        ]);
        expect(rigEventTypes).toEqual([
            "block_start",
            "thinking_start",
            "thinking_delta",
            "thinking_end",
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "tool_execution_start",
            "tool_execution_progress",
            "tool_execution_end",
            "block_stop",
        ]);

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
            agentHome: restarted.daemon.configuration.paths.agentHome,
        });
        expect(reconnected.token).toBe(originalToken);
        await expect(reconnected.client.listSessions()).resolves.toMatchObject({
            sessions: [expect.objectContaining({ id: session.id })],
        });
        if (finishedCursor === undefined) throw new Error("The first run had no durable cursor.");
        const replayedSubmission = await reconnected.client.submitMessage(session.id, {
            text: "Replay from the cursor created before restart.",
        });
        const replayAbort = new AbortController();
        const replayFinished = deferred<unknown>();
        let replayFinishedCursor: string | undefined;
        await reconnected.client.watchSessionEvents({
            after: finishedCursor as EventId,
            onEvent: (event) => {
                if (
                    event.type === "run_finished" &&
                    event.data.runId === replayedSubmission.runId
                ) {
                    replayFinishedCursor = event.id;
                    replayFinished.resolve(event);
                    replayAbort.abort();
                }
            },
            sessionId: session.id,
            signal: replayAbort.signal,
        });
        await expect(replayFinished.promise).resolves.toMatchObject({
            data: { runId: replayedSubmission.runId },
            type: "run_finished",
        });
        if (replayFinishedCursor === undefined) {
            throw new Error("The replayed run had no durable cursor.");
        }
        expect(replayFinishedCursor > finishedCursor).toBe(true);
    });

    it("resets a partial block and resumes the same run across daemon restart", async () => {
        const directory = await createTestSocketDirectory();
        const happyHome = join(directory, ".happy");
        const configuration = await loadHappyAgentConfiguration(happyHome);
        const first = await startRestartFixture(happyHome, 1);
        const connection = await connectHappyAgentProtocolServer({
            agentHome: configuration.paths.agentHome,
        });
        const sessions = await connection.client.listSessions();
        const session = sessions.sessions[0];
        if (session === undefined) throw new Error("Happy Agent exposed no root session.");
        const submitted = await connection.client.submitMessage(session.id, {
            text: "Resume this response after restart.",
        });
        const partial = deferred<void>();
        const reset = deferred<void>();
        const finished = deferred<unknown>();
        const streamedTypes: string[] = [];
        const abort = new AbortController();
        const watching = connection.client.watchSessionEvents({
            after: submitted.eventId,
            onEvent: (event) => {
                if (event.type === "agent_event" && event.data.runId === submitted.runId) {
                    streamedTypes.push(event.data.event.type);
                    if (
                        event.data.providerEvent?.type === "text_delta" &&
                        event.data.providerEvent.delta === "unfinished"
                    ) {
                        partial.resolve();
                    }
                    if (event.data.event.type === "block_reset") reset.resolve();
                }
                if (event.type === "run_finished" && event.data.runId === submitted.runId) {
                    finished.resolve(event);
                    abort.abort();
                }
            },
            sessionId: session.id,
            signal: abort.signal,
        });

        await partial.promise;
        first.kill("SIGKILL");
        await once(first, "exit");
        childDaemons.delete(first);
        const second = await startRestartFixture(happyHome, 2);

        await reset.promise;
        await expect(finished.promise).resolves.toMatchObject({
            data: { runId: submitted.runId, stopReason: "stop" },
            type: "run_finished",
        });
        await watching;
        const resetIndex = streamedTypes.indexOf("block_reset");
        expect(resetIndex).toBeGreaterThanOrEqual(0);
        expect(streamedTypes.indexOf("text_start", resetIndex + 1)).toBeGreaterThan(resetIndex);
        second.send({ type: "shutdown" });
        await once(second, "exit");
        childDaemons.delete(second);
        await rm(directory, { force: true, recursive: true });
    }, 30_000);

    it("gives every tool the daemon assembles an object-rooted parameters schema", async () => {
        const captured: CapturedTool[] = [];
        const fixture = await startTestDaemon(undefined, capturingProvider(captured));
        const connection = await connectHappyAgentProtocolServer({
            agentHome: fixture.daemon.configuration.paths.agentHome,
        });
        const sessions = await connection.client.listSessions();
        const session = sessions.sessions[0];
        if (session === undefined) throw new Error("Happy Agent exposed no root session.");

        await connection.client.submitMessage(session.id, { text: "Assemble the tool set." });

        await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0), { timeout: 15_000 });
        // Anchored on tools whose schemas were rewritten for this rule, so a set that quietly
        // stopped carrying them cannot pass the check below by being empty of anything hard.
        expect(captured.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["create_slot", "list_slots"]),
        );
        // Every vendor mapper puts a tool's parameters through the same sanitizer, which refuses a
        // schema that is not an object at the root, and one refusal fails the whole turn before
        // inference. Checking the assembled set catches a tool no module test would look at.
        expect(
            captured
                .filter(
                    (tool) => tool.parameters !== undefined && tool.parameters.type !== "object",
                )
                .map((tool) => tool.name),
        ).toEqual([]);
    }, 30_000);

    it("ends a failed run as a run_error carrying what the provider said", async () => {
        const fixture = await startTestDaemon(undefined, failingProvider("The provider refused."));
        const connection = await connectHappyAgentProtocolServer({
            agentHome: fixture.daemon.configuration.paths.agentHome,
        });
        const sessions = await connection.client.listSessions();
        const session = sessions.sessions[0];
        if (session === undefined) throw new Error("Happy Agent exposed no root session.");

        const submitted = await connection.client.submitMessage(session.id, {
            text: "Ask something the provider cannot answer.",
        });
        const abort = new AbortController();
        const terminal = deferred<{ readonly data: unknown; readonly type: string }>();
        const watching = connection.client.watchSessionEvents({
            after: submitted.eventId,
            onEvent: (event) => {
                // A failed run has to end as exactly one terminal event, and it has to be the one
                // that carries the failure text, or the transcript shows a turn that simply stops.
                if (event.type === "run_error" || event.type === "run_finished") {
                    terminal.resolve(event);
                    abort.abort();
                }
            },
            sessionId: session.id,
            signal: abort.signal,
        });

        await expect(terminal.promise).resolves.toMatchObject({
            data: { errorMessage: "The provider refused.", runId: submitted.runId },
            type: "run_error",
        });
        await watching;
        await expect(connection.client.getSession(session.id)).resolves.toMatchObject({
            session: { status: "error" },
        });
    }, 30_000);
});

/** A tool as the agent hands it to a provider, narrowed to what the schema rule cares about. */
interface CapturedTool {
    readonly name: string;
    readonly parameters?: { readonly type?: unknown };
}

/** Records the assembled tool set, then answers without calling anything in it. */
function capturingProvider(captured: CapturedTool[]): Parameters<AgentProviders["add"]>[1] {
    return {
        inputTypes: ["text"],
        name: "scripted",
        outputTypes: ["text"],
        session: async (id: string, options: { tools?: readonly CapturedTool[] }) => {
            captured.push(...(options.tools ?? []));
            return {
                id,
                compact: async () => {
                    throw new Error("Compaction is unavailable in this integration test.");
                },
                destroy: () => undefined,
                run: () =>
                    (async function* () {
                        yield { type: "text_start" } as const;
                        yield { type: "text_delta", delta: "Happy Agent replied." } as const;
                        yield { type: "text_end" } as const;
                        yield { type: "done", state: "normal" } as const;
                    })(),
            };
        },
    } as never;
}

/** Fails the run the way a provider does when it cannot answer at all. */
function failingProvider(message: string): Parameters<AgentProviders["add"]>[1] {
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
            run: () =>
                (async function* () {
                    yield {
                        type: "done",
                        state: "error",
                        kind: "internal_error",
                        message,
                    } as const;
                })(),
        }),
    } as never;
}

async function startTestDaemon(
    existingDirectory?: string,
    provider: Parameters<AgentProviders["add"]>[1] = scriptedProvider(),
) {
    const directory = existingDirectory ?? (await createTestSocketDirectory());
    const happyHome = join(directory, ".happy");
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
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
        happyHome,
        integrations: unavailableIntegrations(),
        models,
        provider: "scripted",
        providers,
        version: "integration-test",
    });
    const entry = { ctx, daemon, directory };
    running.add(entry);
    return entry;
}

function scriptedProvider(): Parameters<AgentProviders["add"]>[1] {
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
                    { type: "block_start" },
                    { type: "reasoning_start" },
                    { type: "reasoning_delta", delta: "I should answer through Rig." },
                    { type: "reasoning_end", reasoning: "I should answer through Rig." },
                    { type: "text_start" },
                    { type: "text_delta", delta: "Happy Agent replied through Rig." },
                    { type: "text_end" },
                    {
                        type: "toolcall_start",
                        callId: "server-tool-1",
                        name: "lookup",
                        server: true,
                        vendor: { provider: "scripted" },
                    },
                    {
                        type: "toolcall_delta",
                        callId: "server-tool-1",
                        delta: '{"query":"happy"}',
                    },
                    {
                        type: "toolcall_end",
                        arguments: '{"query":"happy"}',
                        callId: "server-tool-1",
                    },
                    {
                        type: "toolcall_result_start",
                        callId: "server-tool-1",
                        vendor: { provider: "scripted" },
                    },
                    {
                        type: "toolcall_result_delta",
                        callId: "server-tool-1",
                        delta: "found",
                    },
                    {
                        type: "toolcall_result_end",
                        callId: "server-tool-1",
                        content: [{ text: "found", type: "text" }],
                    },
                    { type: "block_stop" },
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

async function startRestartFixture(happyHome: string, attempt: number): Promise<ChildProcess> {
    const child = fork(
        new URL("./fixtures/happyAgentRestartDaemon.ts", import.meta.url),
        [happyHome, String(attempt)],
        {
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
    );
    childDaemons.add(child);
    let diagnostics = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
        diagnostics += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
        const failed = (error: unknown): void => {
            cleanup();
            reject(error);
        };
        const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
            failed(
                new Error(
                    `The restart fixture exited before readiness (${String(code ?? signal)}): ${diagnostics}`,
                ),
            );
        };
        const message = (value: unknown): void => {
            if (value === null || typeof value !== "object") return;
            if (Reflect.get(value, "type") === "ready") {
                cleanup();
                resolve();
            } else if (Reflect.get(value, "type") === "failed") {
                failed(new Error(String(Reflect.get(value, "error"))));
            }
        };
        const cleanup = (): void => {
            child.off("error", failed);
            child.off("exit", exited);
            child.off("message", message);
        };
        child.once("error", failed);
        child.once("exit", exited);
        child.on("message", message);
    });
    return child;
}

function unavailableIntegrations(): HappyAgentIntegrations {
    const unavailable = async () => {
        throw new Error("This integration is unavailable in the Happy Agent integration test.");
    };
    return {
        collaboration: {
            create: async (
                _ctx: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[0],
                _config: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[1],
                options: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[2],
            ) => ({ id: options.id }),
            config: async () => undefined,
            interrupt: unavailable,
            observe: unavailable,
            selection: async () => undefined,
            send: async () => undefined,
            setReadOnly: unavailable,
            spawnCapacity: async () => ({ canSpawn: false, depth: 0, maxDepth: 0 }),
            wait: async () => {
                throw new Error("Collaboration waits are unavailable in this integration test.");
            },
            waitForAgent: unavailable,
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
