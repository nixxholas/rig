import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { createRootContext, type RootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    listFoldersResponseSchema,
    listPluginsResponseSchema,
    listRigProfilesResponseSchema,
    listWorkletsResponseSchema,
    onboardingStatusSchema,
    p2pStatusSchema,
    sharingSnapshotSchema,
    happyCloudStatusSchema,
} from "../../rig-connect/sources/protocol.js";
import { connectHappyAgentProtocolServer } from "../../rig/sources/client/connectHappyAgentProtocolServer.js";
import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
    type HappyAgentIntegrations,
} from "../sources/index.js";
import { createCompatibilitySnapshots } from "../sources/modules/http/compatibilityRoutes.js";

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

describe("Happy Agent Rig compatibility", () => {
    it("keeps every empty compatibility snapshot valid against rig-connect", () => {
        const snapshots = createCompatibilitySnapshots("cursor-1");

        expect(Value.Check(listFoldersResponseSchema, snapshots.folders)).toBe(true);
        expect(Value.Check(listPluginsResponseSchema, snapshots.plugins)).toBe(true);
        expect(Value.Check(listWorkletsResponseSchema, snapshots.worklets)).toBe(true);
        expect(Value.Check(p2pStatusSchema, snapshots.p2p)).toBe(true);
        expect(Value.Check(listRigProfilesResponseSchema, snapshots.profiles)).toBe(true);
        expect(Value.Check(sharingSnapshotSchema, snapshots.sharing)).toBe(true);
        expect(Value.Check(onboardingStatusSchema, snapshots.onboarding)).toBe(true);
        expect(Value.Check(happyCloudStatusSchema, snapshots.happyCloud)).toBe(true);
    });

    it("loads a chat and optional empty collections through the unchanged Rig client", async () => {
        const fixture = await startTestDaemon();
        const connection = await connectHappyAgentProtocolServer({
            agentHome: fixture.daemon.configuration.paths.agentHome,
        });

        await expect(connection.client.health()).resolves.toMatchObject({
            healthy: true,
            protocolVersion: 17,
            ready: true,
        });
        await expect(connection.client.catalog()).resolves.toMatchObject({
            folderItems: [],
            folders: [],
            projects: [],
            protocolVersion: 17,
            sessions: [expect.objectContaining({ scope: { kind: "unsorted" } })],
            sessionsComplete: true,
            workspaces: [],
        });
        const sessions = await connection.client.listSessions();
        const session = sessions.sessions[0];
        expect(session).toMatchObject({
            modelId: "scripted-model",
            permissionMode: "auto",
            providerId: "scripted",
            scope: { kind: "unsorted" },
        });
        if (session === undefined) throw new Error("Happy Agent exposed no root chat.");

        await expect(
            connection.client.getSession(session.id, { messageLimit: 20 }),
        ).resolves.toMatchObject({
            session: {
                agent: {
                    depth: 0,
                    rootSessionId: session.id,
                    type: "primary",
                },
                id: session.id,
                mcpServers: [],
                modelCatalog: {
                    defaultModelId: "scripted-model",
                    defaultProviderId: "scripted",
                },
                pendingUserInputs: [],
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
                snapshot: { messages: [] },
                subagents: [],
                tasks: [],
                workflows: [],
                workflowsEnabled: true,
            },
        });
        await expect(connection.client.listFolders()).resolves.toEqual({
            folders: [],
            items: [],
            revision: 0,
        });
        await expect(connection.client.getP2pStatus()).resolves.toEqual({
            name: "Happy Agent",
            transports: [],
        });
        await expect(connection.client.getHappyCloudStatus()).resolves.toMatchObject({
            authority: "local_record_only",
            enrollment: { state: "not_enrolled" },
            profile: { state: "not_created" },
        });
        await expect(connection.client.listProviderUsage()).resolves.toEqual({ providers: [] });
        await expect(connection.client.listSecrets()).resolves.toEqual({ secrets: [] });
        await expect(connection.client.listPendingExternalToolCalls()).resolves.toEqual({
            calls: [],
        });
        await expect(connection.client.listExternalToolCalls(session.id)).resolves.toEqual({
            calls: [],
        });
        await expect(connection.client.listSubagents(session.id)).resolves.toEqual({
            subagents: [],
        });
        await expect(connection.client.getCurrentProviderQuota(session.id)).resolves.toEqual({
            currentProviderId: "scripted",
        });
        await expect(connection.client.getSessionUsage(session.id)).resolves.toMatchObject({
            currentProviderId: "scripted",
            groups: expect.any(Array),
            quotas: [],
            sessionTokenCount: {
                lastContextTokens: expect.any(Number),
                totalTokens: expect.any(Number),
            },
        });
        await expect(connection.client.getEvents(session.id)).resolves.toMatchObject({
            events: expect.any(Array),
        });
        await expect(connection.client.getPresence()).resolves.toMatchObject({
            presence: {
                presence: { id: "online" },
                presences: expect.arrayContaining([expect.objectContaining({ id: "online" })]),
            },
        });
        const terminal = await connection.client.connectSessionTerminal(session.id, {
            focused: true,
        });
        await terminal.close();

        const state = await requestJson(
            connection.socketPath,
            connection.token,
            `/v0/sessions/${session.id}/state`,
        );
        expect(state).toMatchObject({
            cursor: expect.any(String),
            resumed: false,
            session: {
                id: session.id,
                snapshot: { messages: [] },
            },
            transcript: {
                complete: true,
                messages: [],
                turns: expect.any(Array),
            },
        });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/plugins"),
        ).resolves.toMatchObject({ failures: [], plugins: [], version: "empty" });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/worklets"),
        ).resolves.toEqual({ version: "empty", worklets: [] });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/profiles"),
        ).resolves.toEqual({ profiles: [] });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/onboarding"),
        ).resolves.toEqual({ onboardingVersion: 2, state: "complete" });
        await expect(
            requestJson(connection.socketPath, connection.token, "/v0/sharing"),
        ).resolves.toMatchObject({
            connection: "disconnected",
            contacts: [],
            incomingRequests: [],
            outgoingRequests: [],
        });

        const stateCursor = (state as { readonly cursor?: unknown }).cursor;
        if (typeof stateCursor !== "string") {
            throw new Error("Happy Agent exposed an invalid session state cursor.");
        }
        const streamController = new AbortController();
        let resolveAgentMessage!: () => void;
        const observedAgentMessage = new Promise<void>((resolve) => {
            resolveAgentMessage = resolve;
        });
        const watching = connection.client.watchSessionEvents({
            after: stateCursor,
            onEvent: (event) => {
                if (event.type === "agent_message") resolveAgentMessage();
            },
            sessionId: session.id,
            signal: streamController.signal,
        });
        await expect(
            connection.client.submitMessage(session.id, {
                await: true,
                text: "Hello from Rig.",
            } as never),
        ).resolves.toMatchObject({
            eventId: expect.any(String),
            runId: expect.any(String),
            sessionId: session.id,
        });
        await observedAgentMessage;
        streamController.abort();
        await watching;
        await expect
            .poll(
                async () =>
                    (await connection.client.getSession(session.id)).session.snapshot.messages
                        .length,
                { timeout: 5_000 },
            )
            .toBe(2);
        await expect(connection.client.getSession(session.id)).resolves.toMatchObject({
            session: {
                snapshot: {
                    messages: [
                        { role: "user" },
                        {
                            blocks: [{ text: "Happy Agent replied.", type: "text" }],
                            role: "agent",
                        },
                    ],
                },
            },
        });
        expect(fixture.unexpectedErrors).toEqual([]);
    });
});

async function startTestDaemon() {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "ha-"));
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
    const unexpectedErrors: unknown[] = [];
    const daemon = await startHappyAgentDaemon(ctx, {
        happyHome: join(directory, ".happy"),
        httpConfiguration: {
            onUnexpectedError: (error) => {
                unexpectedErrors.push(error);
            },
            p2pName: "Happy Agent",
        },
        integrations: unavailableIntegrations(),
        models,
        provider: "scripted",
        providers,
        version: "compatibility-test",
    });
    const fixture = { ctx, daemon, directory, unexpectedErrors };
    running.add(fixture);
    return fixture;
}

function scriptedProvider(): Parameters<AgentProviders["add"]>[1] {
    return {
        inputTypes: ["text"],
        name: "scripted",
        outputTypes: ["text"],
        session: async (id: string) => ({
            id,
            compact: async () => {
                throw new Error("Compaction is unavailable in this test.");
            },
            destroy: () => undefined,
            run: () =>
                (async function* () {
                    yield { type: "text_start" } as const;
                    yield { type: "text_delta", delta: "Happy Agent replied." } as const;
                    yield { type: "text_end" } as const;
                    yield {
                        type: "done",
                        state: "normal",
                    } as const;
                })(),
        }),
    } as never;
}

function unavailableIntegrations(): HappyAgentIntegrations {
    const unavailable = async () => {
        throw new Error("This integration is unavailable in the compatibility test.");
    };
    return {
        collaboration: {
            create: async (_ctx, _config, options) => ({ id: options.id }),
            config: async () => undefined,
            interrupt: unavailable,
            observe: unavailable,
            selection: async () => undefined,
            send: async () => undefined,
            setReadOnly: unavailable,
            spawnCapacity: async () => ({ canSpawn: false, depth: 0, maxDepth: 0 }),
            wait: unavailable,
            waitForAgent: unavailable,
        },
        happy: {
            notify: async () => ({ accepted: false }),
            setStatus: async () => ({ accepted: false }),
        },
        imageGeneration: { generate: unavailable },
        mcp: {
            callTool: unavailable,
            getPrompt: unavailable,
            listPrompts: async () => ({ prompts: [] }),
            listResourceTemplates: async () => ({ resourceTemplates: [] }),
            listResources: async () => ({ resources: [] }),
            listServers: async () => ({ servers: [] }),
            listTools: async () => ({ tools: [] }),
            readResource: unavailable,
        },
        scheduling: {
            cancel: unavailable,
            reportDelivery: unavailable,
            schedule: unavailable,
            startWait: unavailable,
            wait: unavailable,
        },
        search: {
            fetch: async (_ctx, _agentId, input) => ({
                content: "",
                truncated: false,
                url: input.url,
            }),
            search: async (_ctx, _agentId, query) => ({
                query: query.query,
                results: [],
            }),
        },
        slots: {
            publisher: async () => undefined,
            scopeResolver: async () => false,
        },
        userInput: { wait: unavailable },
        workflows: {
            cancel: unavailable,
            launch: unavailable,
            resume: unavailable,
            wait: unavailable,
        },
        worklets: {
            invokeOperation: unavailable,
            readLogs: async () => ({ lines: [] }),
            status: async () => ({ name: "unavailable", status: "stopped" }),
        },
    } as unknown as HappyAgentIntegrations;
}

async function requestJson(socketPath: string, token: string, path: string): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                socketPath,
                path,
                method: "GET",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${token}`,
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(
                            new Error(
                                `Happy Agent answered ${String(response.statusCode)}: ${text}`,
                            ),
                        );
                        return;
                    }
                    resolve(JSON.parse(text));
                });
            },
        );
        request.on("error", reject);
        request.end();
    });
}
