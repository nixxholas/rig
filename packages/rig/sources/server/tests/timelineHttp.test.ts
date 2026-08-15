import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { request as httpRequest } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type InferenceStream,
    type Usage,
} from "@slopus/rig-execution";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import type { ModelCatalog, TimelineAgent } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const cleanups: (() => Promise<void>)[] = [];
const ctx = createTestRootContext().named("timeline-http-test");

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("timeline over HTTP", () => {
    it("charts a finished turn as waiting, working, then waiting again", async () => {
        const fixture = await startServer();
        const session = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });
        const submitted = await session.submit(ctx, { text: "Do the thing" });
        await session.waitForRun(ctx, submitted.runId);

        const response = await fixture.post("/timeline", {
            scope: { kind: "session", sessionId: session.id },
        });

        expect(response.status).toBe(200);
        const agent = response.body.agents[0] as TimelineAgent;
        expect(agent.sessionId).toBe(session.id);
        expect(agent.spans.map((span) => span.kind)).toEqual(["waiting", "working", "waiting"]);
        expect(agent.spans[1]).toMatchObject({ outcome: "completed", runId: submitted.runId });
        // The chart is drawn in minutes but every boundary is kept in
        // milliseconds, so a short turn still has a real, ordered duration.
        expect(agent.spans[1]!.endedAt).toBeGreaterThanOrEqual(agent.spans[1]!.startedAt);
        expect(agent.spans[2]!.endedAt).toBeUndefined();
    });

    it("states the stream position the chart reflects", async () => {
        const fixture = await startServer();
        await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });

        const response = await fixture.post("/timeline", {
            scope: { kind: "project", projectId: await projectOf(fixture) },
        });

        expect(response.body.cursor).toBe(fixture.store.liveEvents.cursor());
        expect(response.body.scope).toEqual({
            kind: "project",
            projectId: await projectOf(fixture),
        });
    });

    it("covers every chat in a project and names each row for a person", async () => {
        const fixture = await startServer();
        const first = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });
        const second = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });

        const response = await fixture.post("/timeline", {
            scope: { kind: "project", projectId: await projectOf(fixture) },
        });

        const agents = response.body.agents as TimelineAgent[];
        expect(agents.map((agent) => agent.sessionId).sort()).toEqual([first.id, second.id].sort());
        expect(agents.every((agent) => agent.label === "Untitled chat")).toBe(true);
    });

    it("leaves an archived chat out unless it is asked for", async () => {
        const fixture = await startServer();
        const session = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });
        await session.setArchived(ctx, true);

        const scope = { kind: "project", projectId: await projectOf(fixture) };
        const active = await fixture.post("/timeline", { scope });
        const all = await fixture.post("/timeline", { includeArchived: true, scope });

        expect(active.body.agents).toHaveLength(0);
        expect(all.body.agents).toHaveLength(1);
    });

    it("charts every chat at once for a global scope", async () => {
        const fixture = await startServer();
        const first = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });
        const second = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline-elsewhere",
            modelId: "test/timeline",
            providerId: "test",
        });
        // Two different directories, so these are two different projects; a
        // global chart is the only scope that shows both.
        expect(first.summary().projectId).not.toBe(second.summary().projectId);

        const response = await fixture.post("/timeline", { scope: { kind: "global" } });

        expect(response.status).toBe(200);
        expect(
            (response.body.agents as TimelineAgent[]).map((agent) => agent.sessionId).sort(),
        ).toEqual([first.id, second.id].sort());
        expect(response.body.scope).toEqual({ kind: "global" });
    });

    it("bounds a global chart to recent work while keeping what is still open", async () => {
        const fixture = await startServer();
        const session = await fixture.store.create(ctx, {
            cwd: "/tmp/rig-timeline",
            modelId: "test/timeline",
            providerId: "test",
        });
        const submitted = await session.submit(ctx, { text: "Do the thing" });
        await session.waitForRun(ctx, submitted.runId);

        const response = await fixture.post("/timeline", {
            scope: { kind: "global" },
            since: Date.now() + 60_000,
        });

        // The finished run falls outside the window and is dropped. The chat is
        // still waiting for the person right now, though, so that span has no
        // end to fall outside it and the row survives.
        const agent = (response.body.agents as TimelineAgent[])[0];
        expect(agent?.spans.every((span) => span.endedAt === undefined)).toBe(true);
        expect(agent?.spans.map((span) => span.kind)).toEqual(["waiting"]);
    });

    it("refuses a request that does not say what to chart", async () => {
        const fixture = await startServer();

        const missing = await fixture.post("/timeline", {});
        const nonsense = await fixture.post("/timeline", { scope: { kind: "everything" } });
        const badSince = await fixture.post("/timeline", {
            scope: { kind: "session", sessionId: "s" },
            since: "yesterday",
        });

        expect(missing.status).toBe(400);
        expect(missing.body.error).toContain("global");
        expect(nonsense.status).toBe(400);
        expect(badSince.status).toBe(400);
        expect(badSince.body.error).toContain("milliseconds");
    });

    it("answers with an empty chart for a scope that holds nothing", async () => {
        const fixture = await startServer();

        const response = await fixture.post("/timeline", {
            scope: { kind: "project", projectId: "nothing-here" },
        });

        expect(response.status).toBe(200);
        expect(response.body.agents).toEqual([]);
    });
});

async function projectOf(fixture: { store: InMemorySessionStore }): Promise<string> {
    const project = (await fixture.store.listProjects(ctx))[0];
    if (project === undefined) throw new Error("The store has no project yet.");
    return project.id;
}

async function startServer(): Promise<{
    post: (path: string, body: unknown) => Promise<{ body: any; status: number }>;
    store: InMemorySessionStore;
}> {
    const root = await createTestSocketDirectory();
    const socketPath = join(root, "server.sock");
    const provider = testProvider();
    const store = await InMemorySessionStore.open(ctx, {
        createRuntime: (options) => createTestRuntime(options, provider),
        modelCatalog: testCatalog(provider),
    });
    const server: Server = await createProtocolHttpServer(ctx, {
        store,
        token: "t",
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.close(ctx);
        await rm(root, { force: true, recursive: true });
    });

    const post = async (path: string, body: unknown) =>
        await new Promise<{ body: any; status: number }>((resolve, reject) => {
            const payload = JSON.stringify(body);
            const call = httpRequest(
                {
                    headers: {
                        authorization: "Bearer t",
                        "content-length": Buffer.byteLength(payload),
                        "content-type": "application/json",
                    },
                    method: "POST",
                    path,
                    socketPath,
                },
                (response) => {
                    let raw = "";
                    response.on("data", (chunk) => (raw += String(chunk)));
                    response.on("end", () =>
                        resolve({
                            body: raw.length === 0 ? undefined : JSON.parse(raw),
                            status: response.statusCode ?? 0,
                        }),
                    );
                },
            );
            call.on("error", reject);
            call.end(payload);
        });

    return { post, store };
}

function testProvider(): ReturnType<typeof defineProvider> {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/timeline",
        name: "Timeline model",
        thinkingLevels: ["off"],
    });
    const stream = vi.fn(() =>
        streamFor({
            api: "test",
            content: [{ text: "Done.", type: "text" }],
            model: "test/timeline",
            provider: "test",
            role: "assistant",
            stopReason: "stop",
            timestamp: 1,
            usage: zeroUsage(),
        }),
    );
    return defineProvider({ id: "test", models: [model], stream });
}

function testCatalog(provider: ReturnType<typeof defineProvider>): ModelCatalog {
    return {
        defaultModelId: provider.models[0]?.id ?? "",
        defaultProviderId: provider.id,
        models: [...provider.models],
        providers: [{ models: [...provider.models], providerId: provider.id }],
    };
}

function createTestRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: options.cwd,
        processManager,
    });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        executor: provider,
        processManager,
    };
}

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        async *[Symbol.asyncIterator]() {
            yield { partial: message, type: "start" as const };
            yield { message, reason: "stop" as const, type: "done" as const };
        },
        async result() {
            return message;
        },
    };
}

function zeroUsage(): Usage {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
}
