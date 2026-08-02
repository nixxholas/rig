import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import type { ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { getAgentTreeUsageTool } from "../../tools/get_agent_tree_usage.js";
import type { InMemorySession } from "../InMemorySession.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";
import {
    PersistentSessionStore,
    type PersistentSessionStoreOptions,
} from "../PersistentSessionStore.js";

const execFile = promisify(execFileCallback);

describe("agent tree usage session wiring", () => {
    it("queries nested live subagents through InMemorySession and its manager", async () => {
        const fixture = inferenceFixture();
        const store = new InMemorySessionStore({
            createRuntime: fixture.createRuntime,
            modelCatalog: fixture.catalog,
        });
        const sessions: InMemorySession[] = [];
        try {
            const root = store.create({
                cwd: "/tmp/rig-agent-tree-in-memory",
                modelId: fixture.model.id,
                providerId: fixture.provider.id,
            });
            sessions.push(root);
            const first = await root.externalControlContext().subagents!.spawn({
                background: false,
                description: "Inspect the in-memory path",
                prompt: "Inspect it.",
                taskName: "inspect_memory",
            });
            const firstSession = requiredSession(store, first.sessionId);
            sessions.push(firstSession);
            const nested = await firstSession.externalControlContext().subagents!.spawn({
                background: false,
                description: "Inspect the nested path",
                prompt: "Inspect it again.",
                taskName: "inspect_nested_memory",
            });
            sessions.push(requiredSession(store, nested.sessionId));

            const usage = await getAgentTreeUsageTool.execute(
                {},
                root.externalControlContext(),
                {},
            );
            expect(usage.totalTokens).toBe(22);
            expect(usage.sessions).toEqual([
                expect.objectContaining({
                    relation: "root",
                    sessionId: root.id,
                    totalTokens: 0,
                }),
                expect.objectContaining({
                    description: "Inspect the in-memory path",
                    parentSessionId: root.id,
                    relation: "subagent",
                    sessionId: first.sessionId,
                    status: "completed",
                    taskName: "inspect_memory",
                    totalTokens: 11,
                }),
                expect.objectContaining({
                    description: "Inspect the nested path",
                    parentSessionId: first.sessionId,
                    relation: "subagent",
                    sessionId: nested.sessionId,
                    status: "completed",
                    taskName: "inspect_nested_memory",
                    totalTokens: 11,
                }),
            ]);
        } finally {
            await Promise.allSettled(sessions.map((session) => session.beginShutdown()));
            store.close();
        }
    });

    it("persists reset-surviving usage for nested hidden and visible delegated descendants", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-agent-tree-usage-"));
        const repository = join(directory, "repository");
        const stateDirectory = join(directory, "state");
        const workspacesDirectory = join(directory, "workspaces");
        await Promise.all([
            createRepository(repository),
            mkdir(stateDirectory),
            mkdir(workspacesDirectory),
        ]);
        const databasePath = join(stateDirectory, "sessions.sqlite");
        const fixture = inferenceFixture();
        const options: PersistentSessionStoreOptions = {
            createRuntime: fixture.createRuntime,
            databasePath,
            homeDirectory: directory,
            modelCatalog: fixture.catalog,
            stateDirectory,
            workspacesDirectory,
        };
        let store: PersistentSessionStore | undefined;
        const loadedSessions: InMemorySession[] = [];
        try {
            store = new PersistentSessionStore(options);
            const root = store.create({
                cwd: repository,
                modelId: fixture.model.id,
                providerId: fixture.provider.id,
            });
            loadedSessions.push(root);
            await waitFor(
                () => store?.getProject(root.snapshot().projectId),
                (project) =>
                    project.initializationStatus === "ready" ||
                    project.initializationStatus === "failed",
            );
            expect(store.getProject(root.snapshot().projectId)?.initializationStatus).toBe("ready");

            await submitAndWait(root, "First root turn.");
            expect(root.state()).toMatchObject({
                lifetimeTotalTokens: 11,
                usage: { totalTokens: 11 },
            });
            await root.reset();
            expect(root.state()).toMatchObject({
                lifetimeTotalTokens: 11,
                usage: { totalTokens: 0 },
            });
            await submitAndWait(root, "Second root turn.");
            expect(root.state()).toMatchObject({
                lifetimeTotalTokens: 22,
                usage: { totalTokens: 11 },
            });

            const rootContext = root.externalControlContext();
            const hidden = await rootContext.subagents!.spawn({
                background: false,
                description: "Hidden persistence reviewer",
                prompt: "Review persistence.",
                taskName: "hidden_persistence_review",
            });
            loadedSessions.push(requiredSession(store, hidden.sessionId));

            const workspace = await rootContext.workspaces!.create({
                name: "Visible review",
            });
            const delegated = await rootContext.workspaces!.delegate({
                effort: "off",
                modelId: fixture.model.id,
                prompt: "Review the visible workspace.",
                title: "Visible workspace reviewer",
                workspaceId: workspace.id,
            });
            const delegatedSession = requiredSession(store, delegated.sessionId);
            loadedSessions.push(delegatedSession);
            await waitFor(
                () => delegatedSession.summary(),
                (summary) => summary.status !== "running",
            );
            const nested = await delegatedSession.externalControlContext().subagents!.spawn({
                background: false,
                description: "Nested delegated reviewer",
                prompt: "Review the delegated result.",
                taskName: "nested_delegated_review",
            });
            loadedSessions.push(requiredSession(store, nested.sessionId));
            await waitFor(
                () => root.lifetimeTotalTokens(),
                (totalTokens) => totalTokens === 33,
            );

            const usage = await getAgentTreeUsageTool.execute({}, rootContext, {});
            expect(usage.totalTokens).toBe(66);
            expect(usage.sessions.map((session) => session.sessionId)).toEqual(
                expect.arrayContaining([
                    root.id,
                    hidden.sessionId,
                    delegated.sessionId,
                    nested.sessionId,
                ]),
            );
            expect(usage.sessions).toHaveLength(4);
            expect(rowFor(usage.sessions, root.id)).toMatchObject({
                relation: "root",
                totalTokens: 33,
            });
            expect(rowFor(usage.sessions, hidden.sessionId)).toMatchObject({
                description: "Hidden persistence reviewer",
                parentSessionId: root.id,
                relation: "subagent",
                status: "completed",
                taskName: "hidden_persistence_review",
                totalTokens: 11,
            });
            expect(rowFor(usage.sessions, delegated.sessionId)).toMatchObject({
                parentSessionId: root.id,
                relation: "delegated",
                title: "Visible workspace reviewer",
                totalTokens: 11,
            });
            expect(rowFor(usage.sessions, nested.sessionId)).toMatchObject({
                description: "Nested delegated reviewer",
                parentSessionId: delegated.sessionId,
                relation: "subagent",
                status: "completed",
                taskName: "nested_delegated_review",
                totalTokens: 11,
            });

            await Promise.allSettled(loadedSessions.map((session) => session.beginShutdown()));
            store.close();
            store = undefined;

            const restoredStore = new PersistentSessionStore(options);
            store = restoredStore;
            const restoredRoot = requiredSession(restoredStore, root.id);
            loadedSessions.splice(0, loadedSessions.length, restoredRoot);
            const restoredUsage = await getAgentTreeUsageTool.execute(
                {},
                restoredRoot.externalControlContext(),
                {},
            );
            expect(restoredUsage.totalTokens).toBe(usage.totalTokens);
            expect(withoutStatuses(restoredUsage.sessions)).toEqual(
                withoutStatuses(usage.sessions),
            );
            expect(rowFor(restoredUsage.sessions, hidden.sessionId).status).toBe("completed");
            expect(rowFor(restoredUsage.sessions, nested.sessionId).status).toBe("completed");
        } finally {
            await Promise.allSettled(loadedSessions.map((session) => session.beginShutdown()));
            store?.close();
            await rm(directory, { force: true, recursive: true });
        }
    }, 30_000);
});

function inferenceFixture() {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/agent-tree-usage-test",
        name: "Agent tree usage test",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream(_model, _context, options) {
            const metadata = options?.sessionId?.endsWith(":title") === true;
            const message = assistantMessage(
                model.id,
                metadata
                    ? JSON.stringify({ recap: "Test recap.", title: "Generated title" })
                    : "Done",
                metadata ? 0 : 11,
            );
            return createInferenceStream(async function* () {
                yield { type: "start", partial: { ...message, content: [] } };
                yield { message, reason: "stop", type: "done" };
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ models: [model], providerId: provider.id }],
    };
    return {
        catalog,
        createRuntime: (options: CreateCodingAssistantAgentOptions) =>
            createRuntime(options, provider),
        model,
        provider,
    };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({
        cwd: options.cwd,
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
        processManager,
    });
    if (options.agentCommunication !== undefined) {
        context.agentCommunication = options.agentCommunication;
    }
    if (options.agentTreeUsage !== undefined) context.agentTreeUsage = options.agentTreeUsage;
    if (options.subagents !== undefined) context.subagents = options.subagents;
    if (options.workspaces !== undefined) context.workspaces = options.workspaces;
    return {
        agent: new Agent({
            context,
            ...(options.agentId === undefined ? {} : { id: options.agentId }),
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

function assistantMessage(model: string, text: string, totalTokens: number): AssistantMessage {
    return {
        api: "test",
        content: [{ text, type: "text" }],
        model,
        provider: "codex",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: totalTokens,
            output: 0,
            totalTokens,
        },
    };
}

async function submitAndWait(session: InMemorySession, text: string): Promise<void> {
    const submitted = session.submit({ text });
    const completion = await session.waitForRun(submitted.runId);
    expect(completion.status).toBe("completed");
}

function requiredSession(
    store: Pick<InMemorySessionStore, "get"> | Pick<PersistentSessionStore, "get">,
    sessionId: string,
): InMemorySession {
    const session = store.get(sessionId);
    if (session === undefined) throw new Error(`Expected session '${sessionId}'.`);
    return session;
}

function rowFor<T extends { sessionId: string }>(sessions: readonly T[], sessionId: string): T {
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) throw new Error(`Expected usage for session '${sessionId}'.`);
    return session;
}

function withoutStatuses<T extends { status: string }>(
    sessions: readonly T[],
): Omit<T, "status">[] {
    return sessions.map(({ status: _status, ...session }) => session);
}

async function createRepository(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await git(path, ["init", "--initial-branch=main"]);
    await git(path, ["config", "user.email", "rig@example.test"]);
    await git(path, ["config", "user.name", "Rig Test"]);
    await writeFile(join(path, "README.md"), "fixture\n");
    await git(path, ["add", "README.md"]);
    await git(path, ["commit", "-m", "Initial"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 5_000,
    });
    return result.stdout.trim();
}

async function waitFor<T>(read: () => T | undefined, predicate: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = read();
        if (value !== undefined && predicate(value)) return value;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for session state.");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}
