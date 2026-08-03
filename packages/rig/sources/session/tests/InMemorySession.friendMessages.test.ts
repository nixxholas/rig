import { describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { UserMessage } from "../../agent/types.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
} from "@slopus/rig-execution";
import {
    DEFAULT_FRIEND_CONTEXT_DRAIN_LIMITS,
    InMemorySession,
    type FriendContextDrainResult,
    type InMemorySessionPersistence,
    type PersistedPendingContextMessage,
} from "../InMemorySession.js";

describe("InMemorySession friend messages", () => {
    it("records authenticated friend context passively with stable identity and unread state", () => {
        let now = 100;
        const createRuntime = vi.fn();
        const { catalog, model, provider } = fixtureProvider();
        const session = new InMemorySession({
            createEventId: createEventIdFactory(),
            createRuntime,
            modelCatalog: catalog,
            now: () => now++,
            request: {
                cwd: "/tmp/rig-friend-passive",
                modelId: model.id,
                providerId: provider.id,
                trackUnread: true,
            },
        });
        const before = session.state();
        const message = friendMessage("friend-1", "Please inspect this.");

        session.deliverFriendMessage(message);
        session.deliverFriendMessage(message);

        const after = session.state();
        expect(createRuntime).not.toHaveBeenCalled();
        expect(after.status).toBe("idle");
        expect(after.queuedRuns).toEqual([]);
        expect(after.contextMessages).toEqual([]);
        expect(after.pendingContextMessages?.map((pending) => pending.message.id)).toEqual([
            "friend-1",
        ]);
        expect(after.messages).toMatchObject([
            {
                message: {
                    contextOnly: true,
                    friendAuthor: { kind: "friend", murmurPeerId: "peer-1" },
                    id: "friend-1",
                },
                runId: "friend:friend-1",
            },
        ]);
        expect(after.activeSince).toBe(before.activeSince);
        expect(after.elapsedMs).toBe(before.elapsedMs);
        expect(after.lastMessageAt).toBe(before.lastMessageAt);
        expect(after.metadataRunId).toBe(before.metadataRunId);
        expect(session.snapshot().unread).toMatchObject({ reason: "friend_message" });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "message_submitted"),
        ).toMatchObject([
            {
                data: {
                    delivery: "context",
                    message: { id: "friend-1" },
                    runId: "friend:friend-1",
                },
            },
        ]);
    });

    it("does not steer or disturb an active owner turn when friend context arrives", async () => {
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const contexts: Context[] = [];
        const { catalog, model, provider } = fixtureProvider(contexts, blocked);
        const pending = new Map<string, PersistedPendingContextMessage>();
        const session = createSession({
            catalog,
            modelId: model.id,
            pending,
            persistence: persistenceFor(pending, () => ({
                enabled: false,
                messages: [],
                omittedCount: 0,
                omittedMessageIds: [],
            })),
            provider,
        });
        const submitted = session.submit({ text: "Keep working." });
        await vi.waitFor(() => expect(session.summary().status).toBe("running"));
        const before = session.state();

        session.deliverFriendMessage(friendMessage("friend-during-run", "Background only."));

        const after = session.state();
        expect(after.activeRunId).toBe(submitted.runId);
        expect(after.activeSince).toBe(before.activeSince);
        expect(after.elapsedMs).toBe(before.elapsedMs);
        expect(after.lastMessageAt).toBe(before.lastMessageAt);
        expect(after.pendingContextMessages?.map((entry) => entry.message.id)).toContain(
            "friend-during-run",
        );
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "steering_applied"),
        ).toEqual([]);
        expect(contextSourceIds(contextFor(contexts, "Keep working."))).not.toContain(
            "friend-during-run",
        );

        release();
        await session.waitForRun(submitted.runId);
        await session.beginShutdown();
    });

    it("always drains owner notes but leaves friend backlog untouched when persistence disables it", async () => {
        const contexts: Context[] = [];
        const { catalog, model, provider } = fixtureProvider(contexts);
        const pending = new Map<string, PersistedPendingContextMessage>();
        const drainFriendContextMessages = vi.fn(
            (): FriendContextDrainResult => ({
                enabled: false,
                messages: [],
                omittedCount: 0,
                omittedMessageIds: [],
            }),
        );
        const session = createSession({
            catalog,
            modelId: model.id,
            pending,
            persistence: persistenceFor(pending, drainFriendContextMessages),
            provider,
        });
        session.submitContext({ clientSubmissionId: "owner-note", text: "Owner context." });
        session.deliverFriendMessage(friendMessage("friend-off", "Friend context."));

        const submitted = session.submit({ text: "Do the work." });
        await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
            status: "completed",
        });

        expect(drainFriendContextMessages).toHaveBeenCalledWith({
            limits: DEFAULT_FRIEND_CONTEXT_DRAIN_LIMITS,
            runId: submitted.runId,
            sessionId: session.id,
        });
        const context = contextFor(contexts, "Do the work.");
        expect(contextSourceIds(context)).toContain("owner-note");
        expect(contextSourceIds(context)).not.toContain("friend-off");
        expect(session.state().pendingContextMessages?.map((entry) => entry.message.id)).toEqual([
            "friend-off",
        ]);
        await session.beginShutdown();
    });

    it("includes only persistence-selected newest friend context and adds an invisible omission notice", async () => {
        const contexts: Context[] = [];
        const { catalog, model, provider } = fixtureProvider(contexts);
        const pending = new Map<string, PersistedPendingContextMessage>();
        const drainFriendContextMessages = vi.fn((): FriendContextDrainResult => {
            const friends = [...pending.values()].filter(
                (entry) => entry.message.friendAuthor !== undefined,
            );
            const selected = friends.slice(-1);
            const omitted = friends.slice(0, -1);
            for (const entry of [...selected, ...omitted]) pending.delete(entry.message.id);
            return {
                enabled: true,
                messages: selected,
                omittedCount: omitted.length,
                omittedMessageIds: omitted.map((entry) => entry.message.id),
            };
        });
        const session = createSession({
            catalog,
            modelId: model.id,
            pending,
            persistence: persistenceFor(pending, drainFriendContextMessages),
            provider,
        });
        session.deliverFriendMessage(friendMessage("friend-old", "Older."));
        session.deliverFriendMessage(friendMessage("friend-new", "Newer."));

        const submitted = session.submit({ text: "Use bounded context." });
        await session.waitForRun(submitted.runId);

        const context = contextFor(contexts, "Use bounded context.");
        const ids = contextSourceIds(context);
        expect(ids).toContain("friend-new");
        expect(ids).not.toContain("friend-old");
        expect(ids).toContain(`friend-context-omitted:${submitted.runId}`);
        expect(JSON.stringify(context)).toContain("1 older friend message was omitted");
        expect(session.state().messages.map((entry) => entry.message.id)).not.toContain(
            `friend-context-omitted:${submitted.runId}`,
        );
        expect(session.state().pendingContextMessages).toEqual([]);
        await session.beginShutdown();
    });

    it("removes included friend context from the provider cache while preserving visible history", async () => {
        const contexts: Context[] = [];
        const { catalog, compactContexts, model, provider } = fixtureProvider(contexts);
        const pending = new Map<string, PersistedPendingContextMessage>();
        const drainFriendContextMessages = (): FriendContextDrainResult => {
            const messages = [...pending.values()].filter(
                (entry) => entry.message.friendAuthor !== undefined,
            );
            for (const entry of messages) pending.delete(entry.message.id);
            return {
                enabled: true,
                messages,
                omittedCount: 0,
                omittedMessageIds: [],
            };
        };
        const session = createSession({
            catalog,
            modelId: model.id,
            pending,
            persistence: persistenceFor(pending, drainFriendContextMessages),
            provider,
        });
        session.deliverFriendMessage(friendMessage("friend-toggle", "Temporary context."));
        const first = session.submit({ text: "First owner turn." });
        await session.waitForRun(first.runId);
        expect(contextSourceIds(contextFor(contexts, "First owner turn."))).toContain(
            "friend-toggle",
        );

        session.setFriendMessagesInModel(false);
        expect(session.state().messages.map((entry) => entry.message.id)).toContain(
            "friend-toggle",
        );
        expect(session.state().contextMessages?.map((message) => message.id)).not.toContain(
            "friend-toggle",
        );
        await session.compact();
        expect(contextSourceIds(compactContexts[0]!)).not.toContain("friend-toggle");
        const compaction = session
            .state()
            .messages.map((entry) => entry.message)
            .findLast((message) => message.role === "compaction");
        expect(compaction?.replacedMessageIds).not.toContain("friend-toggle");

        const second = session.submit({ text: "Second owner turn." });
        await session.waitForRun(second.runId);
        expect(contextSourceIds(contextFor(contexts, "Second owner turn."))).not.toContain(
            "friend-toggle",
        );
        await session.beginShutdown();
    });
});

function createSession(options: {
    catalog: ModelCatalog;
    modelId: string;
    pending: Map<string, PersistedPendingContextMessage>;
    persistence: InMemorySessionPersistence;
    provider: ReturnType<typeof defineProvider>;
}): InMemorySession {
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (runtimeOptions) => createRuntime(runtimeOptions, options.provider),
        modelCatalog: options.catalog,
        persistence: options.persistence,
        request: {
            cwd: "/tmp/rig-friend-context",
            modelId: options.modelId,
            providerId: options.provider.id,
        },
    });
}

function persistenceFor(
    pending: Map<string, PersistedPendingContextMessage>,
    drainFriendContextMessages: NonNullable<
        InMemorySessionPersistence["drainFriendContextMessages"]
    >,
): InMemorySessionPersistence {
    return {
        clearMessages() {},
        deleteMessagesFrom() {},
        deleteQueuedRun() {},
        drainFriendContextMessages,
        drainPendingContextMessages(_sessionId, messageIds = []) {
            const selected = messageIds.flatMap((id) => {
                const entry = pending.get(id);
                return entry === undefined ? [] : [entry];
            });
            for (const entry of selected) pending.delete(entry.message.id);
            return selected;
        },
        insertPendingContextMessage(_sessionId, entry) {
            pending.set(entry.message.id, structuredClone(entry));
        },
        insertQueuedRun() {},
        saveSession() {},
        transaction: (body) => body(),
        upsertMessage() {},
    };
}

function fixtureProvider(contexts: Context[] = [], blocked: Promise<void> = Promise.resolve()) {
    const compactContexts: Context[] = [];
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/friend-context",
        name: "Friend context",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        compact: async ({ context }) => {
            compactContexts.push(structuredClone(context));
            return {
                status: "completed",
                context: {
                    ...context,
                    messages: [
                        {
                            content: "Provider summary without excluded friend context.",
                            role: "user",
                            timestamp: 1,
                        },
                    ],
                },
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: 0,
                    output: 0,
                    totalTokens: 0,
                },
            };
        },
        id: "test",
        models: [model],
        stream(_model, context) {
            contexts.push(structuredClone(context));
            const message = assistantMessage(model.id);
            return createInferenceStream(async function* () {
                await blocked;
                yield { type: "done", reason: "stop", message };
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ providerId: provider.id, models: [model] }],
    };
    return { catalog, compactContexts, model, provider };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    return {
        agent: new Agent({
            context,
            ...(options.contextMessages === undefined
                ? {}
                : { contextMessages: options.contextMessages }),
            ...(options.messages === undefined ? {} : { messages: options.messages }),
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

function friendMessage(
    id: string,
    text: string,
): UserMessage & {
    contextOnly: true;
    friendAuthor: NonNullable<UserMessage["friendAuthor"]>;
} {
    return {
        blocks: [{ text, type: "text" }],
        contextOnly: true,
        friendAuthor: {
            displayName: "Grace",
            grantEpoch: 1,
            kind: "friend",
            murmurPeerId: "peer-1",
            shareId: "share-1",
            shareMemberId: "member-1",
        },
        id,
        role: "user",
    };
}

function contextSourceIds(context: Context): string[] {
    return context.messages.flatMap((message) =>
        "sourceMessageId" in message && message.sourceMessageId !== undefined
            ? [message.sourceMessageId]
            : [],
    );
}

function contextFor(contexts: readonly Context[], text: string): Context {
    const context = contexts.find((candidate) => JSON.stringify(candidate).includes(text));
    if (context === undefined)
        throw new Error(`No provider context included ${JSON.stringify(text)}.`);
    return context;
}

function assistantMessage(model: string): AssistantMessage {
    return {
        api: "test",
        content: [{ text: "Done", type: "text" }],
        model,
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}
