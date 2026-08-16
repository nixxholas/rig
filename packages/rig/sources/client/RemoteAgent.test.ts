import { describe, expect, it, vi } from "vitest";

import { createPermissionContext } from "../permissions/index.js";
import { defineModel } from "@slopus/rig-execution";
import type { ModelCatalog, ProtocolSession, SessionEvent } from "../protocol/index.js";
import { createJustBashToolHarness } from "../tools/testing/createJustBashToolHarness.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";
import type { ProtocolHttpClient } from "./ProtocolHttpClient.js";
import { RemoteAgent } from "./RemoteAgent.js";
import { RemoteAgentRunError } from "./RemoteAgentRunError.js";

describe("RemoteAgent", () => {
    const ctx = createTestRootContext();
    it("keeps its local context synchronized with permission responses and events", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const changedSession = { ...session, permissionMode: "full_access" as const };
        const changePermissionMode = vi.fn(async () => ({ session: changedSession }));
        const harness = createJustBashToolHarness();
        harness.context.permissions = createPermissionContext("workspace_write");
        const agent = new RemoteAgent({
            client: { changePermissionMode } as unknown as ProtocolHttpClient,
            context: harness.context,
            session,
        });

        const permissionChange = agent.setPermissionMode("full_access");

        expect(agent.permissionMode).toBe("workspace_write");
        expect(harness.context.permissions.mode).toBe("workspace_write");
        await vi.waitFor(() => expect(changePermissionMode).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(agent.permissionMode).toBe("full_access"));
        await permissionChange;
        expect(harness.context.permissions.mode).toBe("full_access");

        agent.applySessionEvent(permissionEvent(session.id, "read_only"));

        expect(agent.permissionMode).toBe("read_only");
        expect(harness.context.permissions.mode).toBe("read_only");
    });

    it("does not let an older attachment response overwrite a newer event", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        let resolveAttach!: (response: { session: ProtocolSession }) => void;
        const attachSecret = vi.fn(
            () =>
                new Promise<{ session: ProtocolSession }>((resolve) => {
                    resolveAttach = resolve;
                }),
        );
        const agent = new RemoteAgent({
            client: { attachSecret } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session,
        });

        const attaching = agent.attachSecret("service");
        await vi.waitFor(() => expect(attachSecret).toHaveBeenCalledOnce());
        agent.applySessionEvent({
            createdAt: 2,
            data: { projectSecretIds: [], secretIds: [], sessionSecretIds: [] },
            id: "01900000-0000-7002-8000-000000000000",
            sessionId: session.id,
            type: "secrets_changed",
        });
        resolveAttach({
            session: {
                ...session,
                lastEventId: "01900000-0000-7001-8000-000000000000",
                projectSecretIds: [],
                secretIds: ["service"],
                sessionSecretIds: ["service"],
            },
        });

        await attaching;
        expect(agent.secretIds).toEqual([]);
        expect(agent.sessionSecretIds).toEqual([]);
    });

    it("steers the active remote run through the dedicated endpoint", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const steerMessage = vi.fn(async () => ({
            delivery: "steer" as const,
            eventId: "event-2" as const,
            runId: "run-1",
            sessionId: "session-1",
        }));
        const agent = new RemoteAgent({
            client: { steerMessage } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session: { ...protocolSession(model), status: "running" },
        });

        await agent.steer("Change direction.", { displayText: "Change direction." });

        expect(steerMessage).toHaveBeenCalledWith("session-1", {
            displayText: "Change direction.",
            text: "Change direction.",
        });
    });

    it.each(["steer", "run"] as const)(
        "reconciles a lost %s delivery by client submission ID without replaying",
        async (delivery) => {
            const model = defineModel({
                id: "openai/test",
                name: "Test model",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const submitted = {
                createdAt: 2,
                data: {
                    delivery,
                    displayText: "Change direction.",
                    message: {
                        blocks: [{ text: "Change direction.", type: "text" as const }],
                        id: "client-steer-1",
                        role: "user" as const,
                    },
                    runId: "run-1",
                },
                id: "event-2",
                sessionId: "session-1",
                type: "message_submitted" as const,
            };
            const durableEvents: SessionEvent[] = [];
            const steerMessage = vi.fn(async () => {
                durableEvents.push(submitted);
                throw new Error("socket closed after commit");
            });
            const getEvents = vi.fn(async () => ({ events: [...durableEvents] }));
            const agent = new RemoteAgent({
                client: { getEvents, steerMessage } as unknown as ProtocolHttpClient,
                context: createJustBashToolHarness().context,
                session: { ...protocolSession(model), status: "running" },
            });

            await expect(
                agent.steer("Change direction.", {
                    clientSubmissionId: "client-steer-1",
                    displayText: "Change direction.",
                }),
            ).resolves.toEqual({
                delivery,
                eventId: "event-2",
                runId: "run-1",
                sessionId: "session-1",
            });
            expect(steerMessage).toHaveBeenCalledOnce();
            expect(getEvents).toHaveBeenCalledOnce();
            expect(durableEvents).toEqual([submitted]);
        },
    );

    it("keeps session steering out of the snapshot until the daemon applies it", () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const agent = new RemoteAgent({
            client: {} as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session: { ...session, status: "running" },
        });
        const message = {
            blocks: [{ text: "Change direction.", type: "text" as const }],
            id: "steer-1",
            role: "user" as const,
        };

        agent.applySessionEvent({
            createdAt: 1,
            data: {
                delivery: "steer",
                displayText: "Change direction.",
                message,
                runId: "run-1",
            },
            id: "event-submitted",
            sessionId: session.id,
            type: "message_submitted",
        });
        expect(agent.snapshot().messages).toEqual([]);

        agent.applySessionEvent({
            createdAt: 2,
            data: { messageIds: [message.id], runId: "run-1" },
            id: "event-applied",
            sessionId: session.id,
            type: "steering_applied",
        });
        expect(agent.snapshot().messages).toEqual([message]);
    });

    it("keeps the loaded transcript when a current-state session update arrives", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
        });
        const session = protocolSession(model);
        const message = {
            blocks: [{ text: "Already loaded.", type: "text" as const }],
            id: "agent-message-1",
            role: "agent" as const,
        };
        const agent = new RemoteAgent({
            client: {} as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session: {
                ...session,
                snapshot: { ...session.snapshot, messages: [message] },
            },
        });

        agent.applySessionEvent({
            createdAt: 1,
            data: {
                session: {
                    ...session,
                    appendSystemPrompt: "New instructions.",
                    snapshot: { ...session.snapshot, messages: [] },
                },
            },
            id: "event-current-state",
            sessionId: session.id,
            type: "session_updated",
        });

        expect(agent.snapshot().messages).toEqual([message]);
    });

    it("applies the bounded model-context addition carried by a workspace transfer update", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
        });
        const session = protocolSession(model);
        const existing = {
            blocks: [{ text: "Existing context.", type: "text" as const }],
            id: "context-1",
            role: "user" as const,
        };
        const transferNotice = {
            blocks: [{ text: "This session moved workspaces.", type: "text" as const }],
            id: "transfer-context-1",
            internal: true as const,
            role: "system" as const,
        };
        const agent = new RemoteAgent({
            client: {} as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session: {
                ...session,
                snapshot: { ...session.snapshot, contextMessages: [existing] },
            },
        });

        agent.applySessionEvent({
            createdAt: 1,
            data: {
                appendedContextMessage: transferNotice,
                session: {
                    ...session,
                    cwd: "/workspace-two",
                    snapshot: { ...session.snapshot, messages: [] },
                },
            },
            id: "event-workspace-transfer",
            sessionId: session.id,
            type: "session_updated",
        });

        expect(agent.snapshot().contextMessages).toEqual([existing, transferNotice]);
        expect(agent.snapshot().messages).toEqual([]);
    });

    it("keeps goal controls synchronized with responses and events", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const activeGoal = {
            createdAt: 1,
            objective: "Finish the feature",
            status: "active" as const,
            updatedAt: 1,
        };
        const activeSession = { ...session, goal: activeGoal };
        const setGoal = vi.fn(async () => ({ session: activeSession }));
        const changeGoalStatus = vi.fn(async () => ({
            session: { ...activeSession, goal: { ...activeGoal, status: "paused" as const } },
        }));
        const clearGoal = vi.fn(async () => ({ session }));
        const agent = new RemoteAgent({
            client: { changeGoalStatus, clearGoal, setGoal } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session,
        });

        await agent.setGoal(activeGoal.objective);
        expect(agent.goal).toEqual(activeGoal);
        await agent.changeGoalStatus("paused");
        expect(agent.goal?.status).toBe("paused");

        agent.applySessionEvent({
            createdAt: 2,
            data: { goal: { ...activeGoal, status: "blocked" } },
            id: "event-goal",
            sessionId: session.id,
            type: "goal_changed",
        });
        expect(agent.goal?.status).toBe("blocked");

        await agent.clearGoal();
        expect(agent.goal).toBeUndefined();
    });

    it("sends model-only text separately from its transcript label", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const submitMessage = vi.fn(async () => ({
            eventId: "event-submit",
            runId: "run-1",
            sessionId: session.id,
        }));
        const watchSessionEvents = vi.fn(async (options) => {
            await options.onEvent({
                createdAt: 1,
                data: { modelLocked: false, runId: "run-1", stopReason: "stop" },
                id: "event-finished",
                sessionId: session.id,
                type: "run_finished",
            });
        });
        const agent = new RemoteAgent({
            client: { submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session,
        });

        await agent.send(ctx, "Expanded reviewer instructions", { displayText: "/review" });

        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            content: [{ type: "text", text: "Expanded reviewer instructions" }],
            displayText: "/review",
            text: "/review",
        });
    });

    it("aborts the submitted run when the signal was already aborted before listener setup", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const submitMessage = vi.fn(async () => ({
            eventId: "event-submit",
            runId: "run-1",
            sessionId: session.id,
        }));
        const abort = vi.fn(async () => ({ aborted: true }));
        const watchSessionEvents = vi.fn(async () => undefined);
        const agent = new RemoteAgent({
            client: { abort, submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session,
        });
        const controller = new AbortController();
        controller.abort();

        await expect(
            agent.send(ctx, "Stop this submitted run.", { signal: controller.signal }),
        ).resolves.toMatchObject({ runId: "run-1", stopReason: "aborted" });
        expect(abort).toHaveBeenCalledOnce();
        expect(abort).toHaveBeenCalledWith(session.id, { expectedRunId: "run-1" });
    });

    it("preserves the debug directory when a remote run fails", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const submitMessage = vi.fn(async () => ({
            debugDirectory: "/workspace/.happy/rig/debug/request-1",
            eventId: "event-submit",
            runId: "run-1",
            sessionId: session.id,
        }));
        const watchSessionEvents = vi.fn(async (options) => {
            await options.onEvent({
                createdAt: 1,
                data: { errorMessage: "provider failed", modelLocked: false, runId: "run-1" },
                id: "event-error",
                sessionId: session.id,
                type: "run_error",
            });
        });
        const agent = new RemoteAgent({
            client: { submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            debug: true,
            session,
        });

        const failure = await agent
            .send(ctx, "Trigger the failure.")
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(RemoteAgentRunError);
        expect(failure).toMatchObject({
            debugDirectory: "/workspace/.happy/rig/debug/request-1",
            message: "provider failed",
        });
        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            debug: true,
            text: "Trigger the failure.",
        });
    });

    it("keeps models locked across effort changes and queued run boundaries", () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off", "high"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const agent = new RemoteAgent({
            client: {} as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            session,
        });
        agent.applySessionEvent({
            createdAt: 1,
            data: {
                displayText: "Queued work",
                message: {
                    blocks: [{ text: "Queued work", type: "text" }],
                    id: "m1",
                    role: "user",
                },
                runId: "run-1",
            },
            id: "event-submitted",
            sessionId: session.id,
            type: "message_submitted",
        });
        agent.applySessionEvent({
            createdAt: 2,
            data: {
                changed: ["effort"],
                effort: "high",
                modelId: model.id,
                providerId: session.snapshot.providerId,
                serviceTier: null,
            },
            id: "event-effort",
            sessionId: session.id,
            type: "session_configuration_changed",
        });
        expect(agent.canChangeModel).toBe(false);

        agent.applySessionEvent({
            createdAt: 3,
            data: { modelLocked: true, runId: "run-1", stopReason: "stop" },
            id: "event-finished-queued",
            sessionId: session.id,
            type: "run_finished",
        });
        expect(agent.canChangeModel).toBe(false);

        agent.applySessionEvent({
            createdAt: 4,
            data: { modelLocked: false, runId: "run-2", stopReason: "stop" },
            id: "event-finished-idle",
            sessionId: session.id,
            type: "run_finished",
        });
        expect(agent.canChangeModel).toBe(true);
    });

    it("applies a fast-mode choice locally and carries it on the next message", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const changeServiceTier = vi.fn();
        const { submitMessage, watchSessionEvents } = runStub(session.id);
        const agent = new RemoteAgent({
            client: {
                changeServiceTier,
                submitMessage,
                watchSessionEvents,
            } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ models: [model], providerId: "codex", serviceTiers: ["fast"] }],
            },
            session,
        });

        expect(agent.provider.serviceTiers).toEqual(["fast"]);
        agent.setServiceTier("fast");

        expect(changeServiceTier).not.toHaveBeenCalled();
        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(agent.confirmedServiceTier).toBe("fast");

        await agent.send(ctx, "First.");
        expect(submitMessage).toHaveBeenLastCalledWith(session.id, {
            serviceTier: "fast",
            text: "First.",
        });

        // The daemon owns the choice once a run has carried it, so the next message repeats nothing.
        await agent.send(ctx, "Second.");
        expect(submitMessage).toHaveBeenLastCalledWith(session.id, { text: "Second." });

        agent.setServiceTier(undefined);
        expect(agent.snapshot().serviceTier).toBeUndefined();
        await agent.send(ctx, "Third.");
        expect(submitMessage).toHaveBeenLastCalledWith(session.id, {
            serviceTier: null,
            text: "Third.",
        });
    });

    it("keeps only the newest of several rapid fast-mode choices", async () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const { submitMessage, watchSessionEvents } = runStub(session.id);
        const agent = new RemoteAgent({
            client: { submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ models: [model], providerId: "codex", serviceTiers: ["fast"] }],
            },
            session,
        });

        agent.setServiceTier("fast");
        agent.setServiceTier(undefined);

        expect(agent.snapshot().serviceTier).toBeUndefined();
        expect(agent.confirmedServiceTier).toBeUndefined();

        await agent.send(ctx, "Go.");
        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            serviceTier: null,
            text: "Go.",
        });
    });

    it("chooses fast mode even when the session refuses configuration mutations", () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const changeServiceTier = vi.fn(() => {
            throw new Error("Model changes require a queued message.");
        });
        const agent = new RemoteAgent({
            client: { changeServiceTier } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ models: [model], providerId: "codex", serviceTiers: ["fast"] }],
            },
            session,
        });

        agent.setServiceTier("fast");

        expect(changeServiceTier).not.toHaveBeenCalled();
        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(agent.confirmedServiceTier).toBe("fast");
    });

    it("re-asserts a local choice over sessions that still predate it", () => {
        const model = defineModel({
            id: "openai/test",
            name: "Test model",
            thinkingLevels: ["off", "high"],
            defaultThinkingLevel: "off",
        });
        const session = protocolSession(model);
        const agent = new RemoteAgent({
            client: {} as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ models: [model], providerId: "codex", serviceTiers: ["fast"] }],
            },
            session,
        });

        agent.setServiceTier("fast");
        agent.setEffort("high");

        const authoritativeSnapshot = { ...session.snapshot, effort: "off" };
        agent.applySessionEvent({
            createdAt: 1,
            data: {
                changed: ["effort"],
                effort: "off",
                modelId: model.id,
                providerId: session.snapshot.providerId,
                serviceTier: null,
            },
            id: "event-effort",
            sessionId: session.id,
            type: "session_configuration_changed",
        });
        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(agent.snapshot().effort).toBe("high");

        agent.applySessionEvent({
            createdAt: 2,
            data: { snapshot: authoritativeSnapshot, transcript: emptyTranscript() },
            id: "event-reset",
            sessionId: session.id,
            type: "session_reset",
        });
        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(agent.snapshot().effort).toBe("high");

        agent.applySessionEvent({
            createdAt: 3,
            data: {
                messageId: "message-1",
                snapshot: authoritativeSnapshot,
                transcript: emptyTranscript(),
            },
            id: "event-rewound",
            sessionId: session.id,
            type: "session_rewound",
        });
        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(agent.snapshot().effort).toBe("high");
    });

    it("keeps the newest model choice and carries it on the next message", async () => {
        const { modelCatalog, secondModel, session, thirdModel } = remoteModelChangeFixture();
        const changeModel = vi.fn();
        const { submitMessage, watchSessionEvents } = runStub(session.id);
        const agent = new RemoteAgent({
            client: {
                changeModel,
                submitMessage,
                watchSessionEvents,
            } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog,
            session,
        });

        agent.setModel(secondModel.id, "off", "codex");
        agent.setModel(thirdModel.id, "off", "codex");

        expect(changeModel).not.toHaveBeenCalled();
        expect(agent.model.id).toBe(thirdModel.id);
        expect(agent.snapshot().modelId).toBe(thirdModel.id);

        await agent.send(ctx, "Go.");
        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            effort: "off",
            modelId: thirdModel.id,
            providerId: "codex",
            text: "Go.",
        });
    });

    it("keeps a model choice over a session that still names the previous model", async () => {
        const { firstModel, modelCatalog, secondModel, session } = remoteModelChangeFixture();
        const { submitMessage, watchSessionEvents } = runStub(session.id);
        const agent = new RemoteAgent({
            client: { submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog,
            session,
        });

        agent.setModel(secondModel.id, "off", "codex");
        agent.applySessionEvent({
            createdAt: 1,
            data: {
                changed: ["model"],
                effort: "off",
                modelId: firstModel.id,
                providerId: "codex",
                serviceTier: null,
            },
            id: "event-stale-model",
            sessionId: session.id,
            type: "session_configuration_changed",
        });

        expect(agent.model.id).toBe(secondModel.id);
        expect(agent.snapshot().modelId).toBe(secondModel.id);

        await agent.send(ctx, "Go.");
        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            effort: "off",
            modelId: secondModel.id,
            providerId: "codex",
            text: "Go.",
        });

        agent.applySessionEvent({
            createdAt: 2,
            data: {
                changed: ["model"],
                effort: "off",
                modelId: secondModel.id,
                providerId: "codex",
                serviceTier: null,
            },
            id: "event-applied-model",
            sessionId: session.id,
            type: "session_configuration_changed",
        });
        expect(agent.model.id).toBe(secondModel.id);
    });

    it("clears fast mode when choosing a provider that does not support it", async () => {
        const { claudeModel, codexModel, session } = crossProviderFixture();
        const { submitMessage, watchSessionEvents } = runStub(session.id);
        const agent = new RemoteAgent({
            client: { submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: codexModel.id,
                defaultProviderId: "codex",
                models: [codexModel, claudeModel],
                providers: [
                    { models: [codexModel], providerId: "codex", serviceTiers: ["fast"] },
                    { models: [claudeModel], providerId: "claude" },
                ],
            },
            session,
        });

        agent.setModel(claudeModel.id, "off", "claude");

        expect(agent.snapshot()).toMatchObject({
            modelId: claudeModel.id,
            providerId: "claude",
        });
        expect(agent.snapshot().serviceTier).toBeUndefined();

        await agent.send(ctx, "Go.");
        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            effort: "off",
            modelId: claudeModel.id,
            providerId: "claude",
            serviceTier: null,
            text: "Go.",
        });
    });

    it("keeps fast mode when the chosen provider supports it", async () => {
        const { claudeModel, codexModel, session } = crossProviderFixture();
        const { submitMessage, watchSessionEvents } = runStub(session.id);
        const agent = new RemoteAgent({
            client: { submitMessage, watchSessionEvents } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: codexModel.id,
                defaultProviderId: "codex",
                models: [codexModel, claudeModel],
                providers: [
                    { models: [codexModel], providerId: "codex", serviceTiers: ["fast"] },
                    { models: [claudeModel], providerId: "claude", serviceTiers: ["fast"] },
                ],
            },
            session,
        });

        agent.setModel(claudeModel.id, "off", "claude");

        expect(agent.provider.id).toBe("claude");
        expect(agent.snapshot().serviceTier).toBe("fast");

        await agent.send(ctx, "Go.");
        expect(submitMessage).toHaveBeenCalledWith(session.id, {
            effort: "off",
            modelId: claudeModel.id,
            providerId: "claude",
            text: "Go.",
        });
    });
});

function protocolSession(model: ReturnType<typeof defineModel>): ProtocolSession {
    return {
        activity: { kind: "idle", label: "Idle", since: 0 },
        agent: { depth: 0, rootSessionId: "session-1", type: "primary" },
        agentId: "agent-1",
        archived: false,
        cwd: "/workspace",
        id: "session-1",
        ownerInstanceId: "alocalinstance00000000001",
        projectId: "project-1",
        scope: { kind: "project", projectId: "project-1" },
        orderKey: "a0",
        modelId: model.id,
        modelLocked: false,
        modelCatalog: {
            defaultModelId: model.id,
            defaultProviderId: "codex",
            models: [model],
            providers: [{ models: [model], providerId: "codex" }],
        },
        models: [model],
        permissionMode: "workspace_write",
        mcpServers: [],
        pendingUserInputs: [],
        projectSecretIds: [],
        secretIds: [],
        sessionSecretIds: [],
        tasks: [],
        providerId: "codex",
        snapshot: {
            id: "agent-1",
            messages: [],
            modelId: model.id,
            providerId: "codex",
            queue: [],
            status: "idle",
            tools: [],
        },
        status: "idle",
        titleStatus: "idle",
    };
}

function remoteModelChangeFixture(): {
    firstModel: ReturnType<typeof defineModel>;
    modelCatalog: ModelCatalog;
    secondModel: ReturnType<typeof defineModel>;
    session: ProtocolSession;
    thirdModel: ReturnType<typeof defineModel>;
} {
    const firstModel = defineModel({
        id: "openai/first",
        name: "First",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const secondModel = defineModel({
        id: "openai/second",
        name: "Second",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const thirdModel = defineModel({
        id: "openai/third",
        name: "Third",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const models = [firstModel, secondModel, thirdModel];
    const session = { ...protocolSession(firstModel), models };
    return {
        firstModel,
        modelCatalog: {
            defaultModelId: firstModel.id,
            defaultProviderId: "codex",
            models,
            providers: [{ models, providerId: "codex", serviceTiers: ["fast"] }],
        },
        secondModel,
        session,
        thirdModel,
    };
}

function permissionEvent(
    sessionId: string,
    permissionMode: "auto" | "workspace_write" | "read_only" | "full_access",
): SessionEvent {
    return {
        createdAt: 1,
        data: { permissionMode },
        id: "event-1",
        sessionId,
        type: "permission_mode_changed",
    };
}

/** These exercise configuration confirmation, not transcript rebuilding. */
function emptyTranscript() {
    return { complete: true, messages: [], turns: [] };
}
/** Accepts each submitted message and immediately settles its run. */
function runStub(sessionId: string) {
    let runIndex = 0;
    const submitMessage = vi.fn(async () => {
        runIndex += 1;
        return {
            eventId: `event-submit-${runIndex}`,
            runId: `run-${runIndex}`,
            sessionId,
        };
    });
    const watchSessionEvents = vi.fn(async (options) => {
        await options.onEvent({
            createdAt: runIndex,
            data: { modelLocked: false, runId: `run-${runIndex}`, stopReason: "stop" },
            id: `event-finished-${runIndex}`,
            sessionId,
            type: "run_finished",
        });
    });
    return { submitMessage, watchSessionEvents };
}

/** A fast-mode session on one provider, next to a model that lives on another. */
function crossProviderFixture(): {
    claudeModel: ReturnType<typeof defineModel>;
    codexModel: ReturnType<typeof defineModel>;
    session: ProtocolSession;
} {
    const codexModel = defineModel({
        id: "openai/test",
        name: "Codex test",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const claudeModel = defineModel({
        id: "anthropic/test",
        name: "Claude test",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const baseSession = protocolSession(codexModel);
    return {
        claudeModel,
        codexModel,
        session: {
            ...baseSession,
            serviceTier: "fast",
            snapshot: { ...baseSession.snapshot, serviceTier: "fast" },
        },
    };
}
