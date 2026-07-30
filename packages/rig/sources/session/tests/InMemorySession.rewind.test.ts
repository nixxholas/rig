import { describe, expect, it, vi } from "vitest";

import {
    createEventIdFactory,
    type ModelCatalog,
    type SessionEvent,
} from "../../protocol/index.js";
import { defineModel } from "@slopus/rig-execution";
import {
    InMemorySession,
    type InMemorySessionPersistence,
    type PersistedSessionState,
} from "../InMemorySession.js";

describe("InMemorySession rewind", () => {
    it("removes the selected user turn and everything after it", () => {
        const deleteMessagesFrom = vi.fn();
        const session = createRestoredSession(deleteMessagesFrom);

        const result = session.rewind("user-2");

        expect(result.message).toMatchObject({ id: "user-2", role: "user" });
        expect(session.state().totalTokens).toBe(0);
        expect(result.session.sessionTokenCount).toEqual({
            lastContextTokens: 0,
            totalTokens: 0,
        });
        expect(result.session.snapshot.messages.map((message) => message.id)).toEqual([
            "user-1",
            "agent-1",
        ]);
        expect(result.session.permissionReviews).toEqual([]);
        expect(deleteMessagesFrom).toHaveBeenCalledWith("session-1", 2);
        const rewound = session.events
            .since(undefined)
            ?.findLast((event) => event.type === "session_rewound");
        expect(rewound).toMatchObject({
            data: {
                messageId: "user-2",
                snapshot: { messages: [{ id: "user-1" }, { id: "agent-1" }] },
            },
            type: "session_rewound",
        });
        const restarted = createRestoredSession(vi.fn(), session.events.all());
        expect(restarted.snapshot().permissionReviews).toEqual([]);
    });

    it("invalidates the current context when the model changes", () => {
        const session = createRestoredSession(vi.fn());

        session.changeModel({ modelId: "test/next-model", providerId: "test" });

        expect(session.state().totalTokens).toBe(0);
        expect(session.snapshot().sessionTokenCount).toEqual({
            lastContextTokens: 0,
            totalTokens: 0,
        });
    });

    it("rejects a message that is not a visible user turn", () => {
        const session = createRestoredSession(vi.fn());

        expect(() => session.rewind("agent-1")).toThrow(
            "The selected user message is no longer available.",
        );
        expect(() => session.rewind("missing")).toThrow(
            "The selected user message is no longer available.",
        );
    });
});

function createRestoredSession(
    deleteMessagesFrom: (sessionId: string, position: number) => void,
    events?: readonly SessionEvent[],
) {
    const model = defineModel({
        defaultThinkingLevel: "medium",
        id: "test/model",
        name: "Test model",
        thinkingLevels: ["medium"],
    });
    const nextModel = defineModel({
        defaultThinkingLevel: "medium",
        id: "test/next-model",
        name: "Next model",
        thinkingLevels: ["medium"],
    });
    const modelCatalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: "test",
        models: [model, nextModel],
        providers: [{ models: [model, nextModel], providerId: "test" }],
    };
    const messages = [
        { blocks: [{ text: "First", type: "text" as const }], id: "user-1", role: "user" as const },
        {
            blocks: [{ text: "Reply", type: "text" as const }],
            id: "agent-1",
            role: "agent" as const,
        },
        {
            blocks: [{ text: "Second", type: "text" as const }],
            id: "user-2",
            role: "user" as const,
        },
        {
            blocks: [
                {
                    arguments: {},
                    id: "removed-tool",
                    name: "Read",
                    type: "tool_call" as const,
                },
            ],
            id: "agent-2",
            role: "agent" as const,
        },
    ];
    const restore: PersistedSessionState = {
        agent: { depth: 0, rootSessionId: "session-1", type: "primary" },
        agentId: "agent",
        contextMessages: messages,
        cwd: "/tmp/rig-rewind-test",
        id: "session-1",
        messages: messages.map((message, position) => ({
            isPartial: false,
            message,
            position,
        })),
        modelId: model.id,
        models: [model],
        orderKey: "a0",
        nextTaskId: 1,
        permissionMode: "workspace_write",
        permissionReviews: [
            {
                action: "Read file",
                decision: "allow",
                reason: "Requested",
                risk: "low",
                toolCallId: "removed-tool",
                userAuthorization: "high",
            },
        ],
        providerId: "test",
        queuedRuns: [],
        status: "completed",
        tasks: [],
        titleStatus: "ready",
        totalTokens: 123,
        sessionTokenCount: { lastContextTokens: 123, totalTokens: 123 },
        tools: [],
    };
    const persistence: InMemorySessionPersistence = {
        clearMessages: vi.fn(),
        deleteMessagesFrom,
        deleteQueuedRun: vi.fn(),
        insertQueuedRun: vi.fn(),
        saveSession: vi.fn(),
        upsertMessage: vi.fn(),
    };
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        ...(events === undefined ? {} : { events }),
        modelCatalog,
        persistence,
        request: { cwd: restore.cwd },
        restore,
    });
}
