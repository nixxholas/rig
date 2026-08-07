import { describe, expect, it, vi } from "vitest";

import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import { defineModel } from "@slopus/rig-execution";
import { InMemorySession, type InMemorySessionPersistence } from "../InMemorySession.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";
import type { TaskDrain } from "../../utils/TrackedTaskDrain.js";

describe("InMemorySession", () => {
    it("stores idempotent context without starting or queuing a run", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-context-only" });

        const first = session.submitContext({
            clientSubmissionId: "context-note-1",
            text: "The deployment region is eu-west-1.",
        });
        const repeated = session.submitContext({
            clientSubmissionId: "context-note-1",
            text: "The deployment region is eu-west-1.",
        });

        expect(repeated).toEqual(first);
        expect(session.summary().status).toBe("idle");
        expect(session.activity().kind).toBe("idle");
        expect(session.state().queuedRuns).toEqual([]);
        expect(session.state().contextMessages).toEqual([]);
        expect(session.state().messages).toMatchObject([
            {
                message: {
                    contextOnly: true,
                    id: "context-note-1",
                    identity: null,
                    role: "user",
                },
                runId: "context:context-note-1",
            },
        ]);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "message_submitted"),
        ).toHaveLength(1);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toEqual([]);
    });

    it("persists human profile identity on submitted, steering, and context messages", () => {
        const profileId = "aprofile000000000000000003";
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-profile-message" });

        session.submit({ identity: profileId, text: "Run this remotely." });
        session.steer({ identity: profileId, text: "And keep this attribution." });
        session.submitContext({
            identity: profileId,
            text: "This context has the same author.",
        });

        const identities = session.events
            .since(undefined)
            ?.filter((event) => event.type === "message_submitted")
            .map((event) => event.data.message.identity);
        expect(identities).toEqual([profileId, profileId, profileId]);
        void session.abort();
    });

    it("keeps visible-only restored errors out of persisted model context", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/visible-only-error",
            name: "Visible-only error model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "codex",
            models: [model],
            providers: [{ providerId: "codex", models: [model] }],
        };
        const denial = {
            blocks: [{ text: "Automatic permission review refused deployment.", type: "text" }],
            context: "excluded",
            id: "visible-denial",
            outcome: "continued",
            role: "error",
        } as const;
        const session = new InMemorySession({
            createEventId: createEventIdFactory(),
            modelCatalog,
            request: { cwd: "/tmp/rig-visible-only-error" },
            restore: {
                agent: {
                    depth: 0,
                    rootSessionId: "visible-only-session",
                    type: "primary",
                },
                agentId: "visible-only-agent",
                cwd: "/tmp/rig-visible-only-error",
                id: "visible-only-session",
                messages: [{ isPartial: false, message: denial, position: 0, runId: "run-1" }],
                modelId: model.id,
                models: [model],
                nextTaskId: 1,
                orderKey: "a0",
                permissionMode: "auto",
                providerId: "codex",
                queuedRuns: [],
                status: "idle",
                tasks: [],
                titleStatus: "idle",
                tools: [],
            },
        });

        expect(session.state().messages[0]?.message).toEqual(denial);
        expect(session.state().contextMessages).toEqual([]);
    });

    it("rejects an unsupported queued effort before changing session state", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/queued-effort",
            name: "Queued effort model",
            thinkingLevels: ["off", "low"],
        });
        const session = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ providerId: "codex", models: [model] }],
            },
        }).create({ cwd: "/tmp/rig-session-test" });

        expect(() => session.submit({ effort: "high", text: "Do not queue this." })).toThrow(
            "Model 'openai/queued-effort' does not support 'high' reasoning.",
        );
        expect(session.state().messages).toEqual([]);
        expect(session.state().queuedRuns).toEqual([]);
    });

    it("does not retry a queue drain that failed before consuming its run", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/queue-drain-failure",
            name: "Queue drain failure model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "test",
            models: [model],
            providers: [{ providerId: "test", models: [model] }],
        };
        const deleteQueuedRun = vi.fn(() => {
            throw new Error("queue persistence failed");
        });
        const persistence: InMemorySessionPersistence = {
            clearMessages: vi.fn(),
            deleteMessagesFrom: vi.fn(),
            deleteQueuedRun,
            insertQueuedRun: vi.fn(),
            saveSession: vi.fn(),
            upsertMessage: vi.fn(),
        };
        let drainRuns = 0;
        let firstDrain: Promise<unknown> | undefined;
        const taskDrain: TaskDrain = {
            beginClose() {},
            closing: false,
            async drain() {},
            run<T>(task: () => Promise<T>): Promise<T> {
                drainRuns += 1;
                if (drainRuns > 1) return new Promise<T>(() => undefined);
                const running = Promise.resolve().then(task);
                firstDrain = running;
                return running;
            },
        };
        const session = new InMemorySession({
            createEventId: createEventIdFactory(),
            metadata: {
                depth: 1,
                description: "Exercise queue failure handling",
                parentSessionId: "parent-session",
                rootSessionId: "parent-session",
                type: "subagent",
            },
            modelCatalog,
            persistence,
            request: {
                cwd: "/tmp/rig-queue-drain-failure",
                modelId: model.id,
                providerId: "test",
            },
            taskDrain,
        });

        session.submit({ text: "Keep this queued." });
        await firstDrain?.catch(() => undefined);
        await Promise.resolve();

        expect(deleteQueuedRun).toHaveBeenCalledTimes(1);
        expect(drainRuns).toBe(1);
        expect(session.state().queuedRuns).toHaveLength(1);
    });

    it("keeps a subagent out of the ordered list whatever position it is handed", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/subagent-position",
            name: "Subagent position model",
            thinkingLevels: ["off"],
        });
        const modelCatalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "codex",
            models: [model],
            providers: [{ providerId: "codex", models: [model] }],
        };
        const metadata = {
            depth: 1,
            description: "Inspect the ordering",
            parentSessionId: "session-parent",
            rootSessionId: "session-parent",
            type: "subagent",
        } as const;

        const created = new InMemorySession({
            createEventId: createEventIdFactory(),
            metadata,
            modelCatalog,
            orderKey: "a0",
            request: { cwd: "/tmp/rig-subagent-position" },
        });
        const restored = new InMemorySession({
            createEventId: createEventIdFactory(),
            modelCatalog,
            request: { cwd: "/tmp/rig-subagent-position" },
            restore: {
                agent: metadata,
                agentId: "agent-2",
                cwd: "/tmp/rig-subagent-position",
                id: "subagent-1",
                messages: [],
                modelId: model.id,
                models: [],
                nextTaskId: 1,
                orderKey: "a1",
                permissionMode: "workspace_write",
                providerId: "codex",
                queuedRuns: [],
                status: "completed",
                tasks: [],
                titleStatus: "idle",
                tools: [],
            },
        });

        for (const session of [created, restored]) {
            expect(session.snapshot().orderKey).toBeUndefined();
            expect(session.summary().orderKey).toBeUndefined();
            expect(session.state().orderKey).toBe("");
        }
    });

    it("treats repeated client submission IDs as one durable message", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });

        const first = session.submit({ clientSubmissionId: "mobile-message-1", text: "Continue." });
        const repeated = session.submit({
            clientSubmissionId: "mobile-message-1",
            text: "Continue.",
        });

        expect(repeated).toEqual(first);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "message_submitted"),
        ).toHaveLength(1);
        session.abort();
    });

    it("persists direct shell results as pending model history without starting a run", async () => {
        const session = new InMemorySessionStore().create({
            cwd: "/tmp/rig-session-test",
            permissionMode: "full_access",
        });

        const result = await session.runShellCommand({
            command: "printf persisted-shell-output",
            commandId: "shell-command-1",
        });

        expect(result).toMatchObject({
            command: "printf persisted-shell-output",
            commandId: "shell-command-1",
        });
        await vi.waitFor(() => {
            expect(session.state().messages.at(-1)).toMatchObject({
                isPartial: false,
                message: {
                    blocks: [
                        {
                            text: expect.stringContaining("<user_shell_command>"),
                            type: "text",
                        },
                    ],
                    role: "user",
                },
                runId: "shell:shell-command-1",
            });
        });
        expect(session.snapshot().snapshot.queue.at(-1)?.message).toMatchObject({
            blocks: [{ text: expect.stringContaining("persisted-shell-output"), type: "text" }],
            role: "user",
        });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(0);
    });

    it("queues steering as a new run when no run is active", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });

        const accepted = session.steer({
            clientSubmissionId: "queued-after-finish",
            expectedRunId: "finished-run",
            text: "Continue in a new turn.",
        });

        expect(accepted).toMatchObject({ delivery: "run" });
        expect(
            session.events.since(undefined)?.find((event) => event.id === accepted.eventId),
        ).toMatchObject({
            data: {
                delivery: "run",
                message: { id: "queued-after-finish" },
                runId: accepted.runId,
            },
            type: "message_submitted",
        });
    });

    it("keeps the original run delivery when retrying a committed submission through steering", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });
        const submitted = session.submit({
            clientSubmissionId: "committed-run",
            text: "Continue in a new turn.",
        });

        expect(
            session.steer({
                clientSubmissionId: "committed-run",
                expectedRunId: "finished-run",
                text: "Continue in a new turn.",
            }),
        ).toEqual({ ...submitted, delivery: "run" });
        expect(
            session.events
                .since(undefined)
                ?.filter(
                    (event) =>
                        event.type === "message_submitted" &&
                        event.data.message.id === "committed-run",
                ),
        ).toHaveLength(1);
    });

    it("wakes an idle session for a notification", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });

        const delivered = session.deliverNotification({
            displayText: "Background work finished.",
            text: "<subagent-notification>Done</subagent-notification>",
        });

        expect(session.summary().status).toBe("running");
        expect(session.snapshot().snapshot).toMatchObject({
            messages: [
                {
                    blocks: [
                        {
                            text: "Background work finished.",
                            type: "text",
                        },
                    ],
                    role: "user",
                },
            ],
        });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(1);
        expect(
            session.events.since(undefined)?.find((event) => event.type === "message_submitted"),
        ).toMatchObject({ data: { source: "notification" } });
        expect(delivered.runId).toBe(
            session.events.since(undefined)?.find((event) => event.type === "run_started")?.data
                .runId,
        );
        session.abort();
    });

    it("wakes an idle session for an agent message", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });

        session.deliverAgentMessage({
            agentSource: {
                agentId: "sender-agent-id",
                sessionId: "sender-session-id",
                title: "Sender chat",
            },
            blocks: [{ text: "Wake up and handle this.", type: "text" }],
            id: "agent-message-1",
            provenance: "agent",
            role: "user",
        });

        expect(session.summary().status).toBe("running");
        expect(
            session.events.since(undefined)?.find((event) => event.type === "message_submitted"),
        ).toMatchObject({
            data: {
                delivery: "run",
                message: {
                    agentSource: {
                        agentId: "sender-agent-id",
                        sessionId: "sender-session-id",
                        title: "Sender chat",
                    },
                    id: "agent-message-1",
                    provenance: "agent",
                },
            },
        });
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(1);
        session.abort();
    });

    it("queues later notifications as steering on the run woken by the first", () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });

        const first = session.deliverNotification({
            displayText: "First background agent finished.",
            text: "<subagent-notification>First</subagent-notification>",
        });
        const second = session.deliverNotification({
            displayText: "Second background agent finished.",
            text: "<subagent-notification>Second</subagent-notification>",
        });

        expect(second.runId).toBe(first.runId);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "run_started"),
        ).toHaveLength(1);
        const snapshot = session.snapshot().snapshot;
        expect(snapshot.messages).toEqual([
            expect.objectContaining({
                blocks: [{ text: "First background agent finished.", type: "text" }],
            }),
            expect.objectContaining({
                blocks: [{ text: "Second background agent finished.", type: "text" }],
            }),
        ]);
        expect(snapshot.queue).toEqual([
            expect.objectContaining({
                message: expect.objectContaining({
                    blocks: [
                        {
                            text: "<subagent-notification>Second</subagent-notification>",
                            type: "text",
                        },
                    ],
                }),
            }),
        ]);
        session.abort();
    });

    it("preserves the user-facing stop reason when workflow cancellation rejects", async () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });
        const run = session.launchWorkflow({
            code: "42",
            description: "Wait for cancellation",
            execute: ({ signal }) =>
                new Promise<never>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("Internal cancellation detail.")),
                        { once: true },
                    );
                }),
            name: "cancellation-check",
        });

        expect(session.stopWorkflow(run.runId)).toMatchObject({
            error: "The workflow was stopped.",
            status: "stopped",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(session.getWorkflow(run.runId)).toMatchObject({
            error: "The workflow was stopped.",
            status: "stopped",
        });
        session.abort();
    });

    it("publishes live workflow phase, progress, and completion state", async () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });
        const run = session.launchWorkflow({
            code: "42",
            description: "Inspect the workflow state",
            execute: async ({ onAgentCall, onLog }) => {
                onLog("Phase: Inspect");
                onAgentCall();
                onLog("Checked the target.");
                return { agentCalls: [], output: { checked: true } };
            },
            name: "state-check",
        });

        await new Promise((resolve) => setImmediate(resolve));

        expect(session.snapshot().workflows).toEqual([
            expect.objectContaining({
                agentCount: 1,
                description: "Inspect the workflow state",
                logs: ["Phase: Inspect", "Checked the target."],
                output: { checked: true },
                phase: "Inspect",
                runId: run.runId,
                status: "completed",
            }),
        ]);
        expect(
            session.events.since(undefined)?.filter((event) => event.type === "workflow_changed"),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    data: { update: expect.objectContaining({ status: "running" }) },
                }),
                expect.objectContaining({
                    data: {
                        update: expect.objectContaining({
                            output: { checked: true },
                            status: "completed",
                        }),
                    },
                }),
            ]),
        );
        session.abort();
    });

    it("resumes unchanged workflow code from its latest Monty checkpoint", async () => {
        const session = new InMemorySessionStore().create({ cwd: "/tmp/rig-session-test" });
        const checkpoint = {
            nextAgentCallIndex: 1,
            phase: "Verify",
            snapshot: new Uint8Array([1, 2, 3]),
        };
        const cachedAgent = { output: "cached", signature: "cached-signature" };
        const interrupted = session.launchWorkflow({
            code: 'agent("check")',
            description: "Checkpoint a workflow",
            execute: async ({ onAgentResult, onCheckpoint }) => {
                onAgentResult(0, cachedAgent);
                onCheckpoint(checkpoint);
                throw new Error("Simulated workflow interruption.");
            },
            name: "checkpointed-workflow",
        });
        await new Promise((resolve) => setImmediate(resolve));

        let receivedResumeCheckpoint: unknown;
        let receivedResumeAgentCalls: readonly unknown[] = [];
        session.launchWorkflow({
            code: 'agent("check")',
            description: "Resume a workflow",
            execute: async (options) => {
                receivedResumeCheckpoint = options.resumeCheckpoint;
                receivedResumeAgentCalls = options.resumeAgentCalls;
                return { agentCalls: options.resumeAgentCalls, output: "resumed" };
            },
            name: "checkpointed-workflow",
            resumeFromRunId: interrupted.runId,
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(receivedResumeCheckpoint).toEqual(checkpoint);
        expect(receivedResumeAgentCalls).toEqual([cachedAgent]);
        session.abort();
    });

    it("routes the same canonical model through the explicitly selected provider", () => {
        const sharedModel = defineModel({
            defaultThinkingLevel: "medium",
            id: "openai/shared",
            name: "Shared model",
            thinkingLevels: ["medium"],
        });
        const bedrockOnlyModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/bedrock-only",
            name: "Bedrock-only model",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: sharedModel.id,
            defaultProviderId: "codex",
            models: [sharedModel, bedrockOnlyModel],
            providers: [
                { providerId: "codex", models: [sharedModel] },
                { providerId: "bedrock", models: [sharedModel, bedrockOnlyModel] },
            ],
        };
        const store = new InMemorySessionStore({ modelCatalog: catalog });

        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: sharedModel.id,
            providerId: "bedrock",
        });

        expect(session.snapshot()).toMatchObject({
            modelId: sharedModel.id,
            models: [sharedModel, bedrockOnlyModel],
            providerId: "bedrock",
        });

        session.changeModel({ modelId: sharedModel.id, providerId: "codex" });

        expect(session.snapshot()).toMatchObject({
            modelId: sharedModel.id,
            models: [sharedModel],
            providerId: "codex",
        });
        const latestEvent = session.events.since(undefined)?.at(-1);
        expect(latestEvent).toBeDefined();
        if (latestEvent === undefined) {
            throw new Error("Expected a model change event.");
        }
        expect(latestEvent).toMatchObject({
            data: {
                modelId: sharedModel.id,
                snapshot: { providerId: "codex" },
            },
            type: "session_configuration_changed",
        });

        const inferredSession = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: bedrockOnlyModel.id,
        });
        expect(inferredSession.snapshot()).toMatchObject({
            modelId: bedrockOnlyModel.id,
            providerId: "bedrock",
        });
    });

    it("keeps fast inference across Codex model changes and rejects unsupported providers", () => {
        const firstCodexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/first",
            name: "First Codex model",
            thinkingLevels: ["off"],
        });
        const secondCodexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/second",
            name: "Second Codex model",
            thinkingLevels: ["off"],
        });
        const claudeModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/test",
            name: "Claude model",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: firstCodexModel.id,
            defaultProviderId: "codex",
            models: [firstCodexModel, secondCodexModel, claudeModel],
            providers: [
                {
                    providerId: "codex",
                    providerType: "codex",
                    models: [firstCodexModel, secondCodexModel],
                    serviceTiers: ["fast"],
                },
                {
                    providerId: "claude",
                    providerType: "claude",
                    models: [claudeModel],
                },
            ],
        };
        const store = new InMemorySessionStore({ modelCatalog: catalog });
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: firstCodexModel.id,
            providerId: "codex",
            serviceTier: "fast",
        });

        session.changeModel({ modelId: secondCodexModel.id, providerId: "codex" });

        expect(session.snapshot()).toMatchObject({
            modelId: secondCodexModel.id,
            providerId: "codex",
            serviceTier: "fast",
            snapshot: { serviceTier: "fast" },
        });
        expect(session.snapshot().snapshot.contextMessages).toBeUndefined();
        expect(session.state().serviceTier).toBe("fast");

        session.changeServiceTier({});
        expect(session.snapshot().serviceTier).toBeUndefined();
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: { changed: ["serviceTier"], serviceTier: null },
            type: "session_configuration_changed",
        });

        session.changeModel({ modelId: claudeModel.id, providerId: "claude" });
        expect(session.snapshot().snapshot.contextMessages).toBeUndefined();
        expect(() => session.changeServiceTier({ serviceTier: "fast" })).toThrow(
            "does not support fast inference",
        );

        const unsupportedDefault = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: claudeModel.id,
            providerId: "claude",
            serviceTier: "fast",
        });
        expect(unsupportedDefault.snapshot().serviceTier).toBeUndefined();
    });

    it("carries a model, reasoning, and fast mode change on a message and reports them as one event", () => {
        const { store, fastModel, slowModel } = configurableCatalog();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: slowModel.id,
            providerId: "codex",
        });

        session.submit({
            effort: "high",
            modelId: fastModel.id,
            serviceTier: "fast",
            text: "Use the other model.",
        });

        expect(session.snapshot()).toMatchObject({
            effort: "high",
            modelId: fastModel.id,
            serviceTier: "fast",
        });
        // Three settings moved together, so they are reported once rather than as three events a
        // reader would have to reassemble.
        const configurationEvents = session.events
            .since(undefined)
            ?.filter((event) => event.type === "session_configuration_changed");
        expect(configurationEvents).toHaveLength(1);
        expect(configurationEvents?.[0]).toMatchObject({
            data: {
                changed: ["model", "effort", "serviceTier"],
                effort: "high",
                modelId: fastModel.id,
                serviceTier: "fast",
            },
        });
    });

    it("does not report a configuration field a message left where it already was", () => {
        const { store, fastModel } = configurableCatalog();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: fastModel.id,
            providerId: "codex",
        });

        session.submit({ effort: "high", modelId: fastModel.id, text: "Same model." });

        const configurationEvents = session.events
            .since(undefined)
            ?.filter((event) => event.type === "session_configuration_changed");
        expect(configurationEvents).toHaveLength(1);
        // The model was already selected, so only the reasoning level actually moved.
        expect(configurationEvents?.[0]).toMatchObject({ data: { changed: ["effort"] } });
    });

    it("rejects a message whose reasoning the model it also selects cannot do", () => {
        const { store, fastModel, slowModel } = configurableCatalog();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: fastModel.id,
            providerId: "codex",
        });

        // "high" is valid for the currently selected model, so a check against the current model
        // rather than the requested one would let this through.
        expect(() =>
            session.submit({ effort: "high", modelId: slowModel.id, text: "Think hard." }),
        ).toThrow("does not support 'high' reasoning");
        expect(() => session.submit({ effort: "nonsense", text: "Think hard." })).toThrow(
            "does not support 'nonsense' reasoning",
        );
    });

    it("validates reasoning against the model an earlier message switched to", () => {
        const { store, fastModel, slowModel } = configurableCatalog();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: fastModel.id,
            providerId: "codex",
        });

        session.submit({ modelId: slowModel.id, text: "Switch models." });
        // By the time this runs the session is on the model the queued message selected.
        expect(() => session.submit({ effort: "high", text: "Think hard." })).toThrow(
            "does not support 'high' reasoning",
        );
    });

    it("lets a steer with nothing to interrupt carry configuration, because it is queued", () => {
        const { store, fastModel, slowModel } = configurableCatalog();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: slowModel.id,
            providerId: "codex",
        });

        // With no run in flight a steer becomes an ordinary queued message, which is the only
        // delivery that may carry configuration.
        const queued = session.steer({ modelId: fastModel.id, text: "Change it." });
        expect(queued.delivery).toBe("run");
        expect(session.snapshot().modelId).toBe(fastModel.id);
    });

    it("falls back when the configured model is no longer available", () => {
        const availableModel = defineModel({
            defaultThinkingLevel: "medium",
            id: "openai/available",
            name: "Available model",
            thinkingLevels: ["off", "medium"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: availableModel.id,
            defaultProviderId: "codex",
            models: [availableModel],
            providers: [{ providerId: "codex", models: [availableModel] }],
        };
        const store = new InMemorySessionStore({ modelCatalog: catalog });

        const session = store.create({
            cwd: "/tmp/rig-session-test",
            effort: "max",
            modelId: "removed/model",
            providerId: "bedrock",
        });

        expect(session.snapshot()).toMatchObject({
            effort: "medium",
            modelId: availableModel.id,
            models: [availableModel],
            providerId: "codex",
        });
    });

    it("keeps the requested model when another enabled provider serves it", () => {
        const sharedModel = defineModel({
            defaultThinkingLevel: "medium",
            id: "openai/shared",
            name: "Shared model",
            thinkingLevels: ["medium"],
        });
        const fallbackModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/fallback",
            name: "Fallback model",
            thinkingLevels: ["off"],
        });
        const catalog: ModelCatalog = {
            defaultModelId: fallbackModel.id,
            defaultProviderId: "codex",
            models: [fallbackModel, sharedModel],
            providers: [
                { providerId: "codex", models: [fallbackModel] },
                { providerId: "openai", models: [sharedModel] },
            ],
        };
        const store = new InMemorySessionStore({ modelCatalog: catalog });

        const session = store.create({
            cwd: "/tmp/rig-session-test",
            modelId: sharedModel.id,
            providerId: "bedrock",
        });

        expect(session.snapshot()).toMatchObject({
            modelId: sharedModel.id,
            models: [sharedModel],
            providerId: "openai",
        });
    });

    it("changes permissions and passes them to subagents", async () => {
        const store = new InMemorySessionStore();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            permissionMode: "read_only",
        });

        expect(session.snapshot().permissionMode).toBe("read_only");
        expect(session.requestForSubagent().permissionMode).toBe("read_only");

        await session.changePermissionMode({ permissionMode: "full_access" });

        expect(session.snapshot().permissionMode).toBe("full_access");
        expect(session.requestForSubagent().permissionMode).toBe("full_access");
        expect(session.events.since(undefined)).toContainEqual(
            expect.objectContaining({
                data: { permissionMode: "full_access" },
                type: "permission_mode_changed",
            }),
        );
    });

    it("broadcasts a composer draft to attached clients and clears it", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });
        const delivered: unknown[] = [];
        session.events.subscribe((event) => {
            if (event.type === "session_draft_changed") delivered.push(event.data);
        });

        expect(session.snapshot().draft).toBeUndefined();

        session.setDraft({ draft: "Fix the flaky test", origin: "terminal-a" });
        expect(session.snapshot().draft).toBe("Fix the flaky test");
        expect(session.summary().draft).toBe("Fix the flaky test");
        expect(delivered).toEqual([
            { draft: "Fix the flaky test", origin: "terminal-a", updatedAt: expect.any(Number) },
        ]);

        // Rewriting the same draft is not a change worth broadcasting.
        session.setDraft({ draft: "Fix the flaky test" });
        expect(delivered).toHaveLength(1);

        session.setDraft({ draft: null });
        expect(session.snapshot().draft).toBeUndefined();
        expect(delivered).toEqual([
            { draft: "Fix the flaky test", origin: "terminal-a", updatedAt: expect.any(Number) },
            { updatedAt: expect.any(Number) },
        ]);
    });

    it("keeps the draft that was typed most recently, not the one that arrived last", () => {
        const now = Date.now();
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });
        const delivered: unknown[] = [];
        session.events.subscribe((event) => {
            if (event.type === "session_draft_changed") delivered.push(event.data);
        });

        session.setDraft({ draft: "typed second", origin: "phone", updatedAt: now - 1_000 });
        expect(session.snapshot().draft).toBe("typed second");
        expect(session.snapshot().draftUpdatedAt).toBe(now - 1_000);

        // A slow client delivers a message that was typed earlier. It loses.
        session.setDraft({ draft: "typed first", origin: "terminal-a", updatedAt: now - 5_000 });
        expect(session.snapshot().draft).toBe("typed second");
        expect(delivered).toHaveLength(1);

        // A message typed after the stored one replaces it.
        session.setDraft({ draft: "typed third", origin: "terminal-a", updatedAt: now - 100 });
        expect(session.snapshot().draft).toBe("typed third");
        expect(delivered).toHaveLength(2);

        // A stale clear cannot wipe a newer draft either.
        session.setDraft({ draft: null, origin: "phone", updatedAt: now - 4_000 });
        expect(session.snapshot().draft).toBe("typed third");
        expect(delivered).toHaveLength(2);
    });

    it("refuses to date a draft in the future or before the skew window", () => {
        const store = new InMemorySessionStore();

        // A clock running fast cannot claim a draft from the future and win
        // against everything typed after it.
        const fast = store.create({ cwd: "/tmp/rig-session-fast" });
        const beforeFast = Date.now();
        fast.setDraft({ draft: "from a fast clock", updatedAt: beforeFast + 3_600_000 });
        expect(fast.snapshot().draftUpdatedAt).toBeGreaterThanOrEqual(beforeFast);
        expect(fast.snapshot().draftUpdatedAt).toBeLessThanOrEqual(Date.now());

        // A clock far in the past is held at the edge of the skew window, so it
        // loses to recent drafts instead of being unable to win at all.
        const slow = store.create({ cwd: "/tmp/rig-session-slow" });
        const beforeSlow = Date.now();
        slow.setDraft({ draft: "from a slow clock", updatedAt: 0 });
        expect(slow.snapshot().draftUpdatedAt).toBeGreaterThanOrEqual(beforeSlow - 300_000);
        expect(slow.snapshot().draftUpdatedAt).toBeLessThanOrEqual(Date.now() - 300_000);
    });

    it("keeps drafts out of the durable event log", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });

        session.setDraft({ draft: "Typed but never sent" });

        // The latest draft lives on the session itself, so a reconnecting client
        // reads it from the snapshot instead of replaying every keystroke burst.
        expect(
            session.events
                .since(undefined)
                ?.some((event) => event.type === "session_draft_changed"),
        ).toBe(false);
    });

    it("treats an empty draft as no draft", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });

        session.setDraft({ draft: "" });

        expect(session.snapshot().draft).toBeUndefined();
    });

    it("refuses a draft that is too long to sync", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });

        expect(() => session.setDraft({ draft: "x".repeat(100_001) })).toThrow(
            "The draft is too long to sync.",
        );
        expect(session.snapshot().draft).toBeUndefined();
    });

    it("holds a structured question until the user answers it", async () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });
        const request = {
            requestId: "question-1",
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [
                        { label: "PostgreSQL", description: "Use a server database." },
                        { label: "SQLite", description: "Use a local database." },
                    ],
                    question: "Which database should be used?",
                },
            ],
        };

        const pending = session.requestUserInput(request);

        expect(session.snapshot().pendingUserInputs).toEqual([request]);
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: request,
            type: "user_input_requested",
        });

        session.answerUserInput("question-1", { answers: { database: ["PostgreSQL"] } });

        await expect(pending).resolves.toEqual({
            status: "answered",
            answers: { database: ["PostgreSQL"] },
        });
        expect(session.snapshot().pendingUserInputs).toEqual([]);
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: {
                answers: { database: ["PostgreSQL"] },
                requestId: "question-1",
                status: "answered",
            },
            type: "user_input_resolved",
        });
    });

    it("tracks unread attention only when the root session opts in", async () => {
        const store = new InMemorySessionStore();
        const session = store.create({
            cwd: "/tmp/rig-session-test",
            trackUnread: true,
        });
        const request = {
            requestId: "question-unread",
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [
                        { label: "PostgreSQL", description: "Use a server database." },
                        { label: "SQLite", description: "Use a local database." },
                    ],
                    question: "Which database should be used?",
                },
            ],
        };

        const pending = session.requestUserInput(request);

        expect(session.snapshot()).toMatchObject({
            trackUnread: true,
            unread: { reason: "attention_needed" },
        });
        expect(session.markRead()).toBe(true);
        expect(session.snapshot().unread).toBeUndefined();
        expect(session.markRead()).toBe(false);

        session.answerUserInput("question-unread", { answers: { database: ["SQLite"] } });
        await expect(pending).resolves.toEqual({
            status: "answered",
            answers: { database: ["SQLite"] },
        });

        const untracked = store.create({ cwd: "/tmp/rig-session-test" });
        const untrackedPending = untracked.requestUserInput({
            ...request,
            requestId: "question-untracked",
        });
        expect(untracked.snapshot().trackUnread).toBe(false);
        expect(untracked.snapshot().unread).toBeUndefined();
        untracked.answerUserInput("question-untracked", {
            answers: { database: ["PostgreSQL"] },
        });
        await untrackedPending;
    });

    it("cancels a pending question when its run is aborted", async () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-session-test" });
        const controller = new AbortController();
        const pending = session.requestUserInput(
            {
                requestId: "question-1",
                questions: [
                    {
                        header: "Choice",
                        id: "choice",
                        multiSelect: false,
                        options: [
                            { label: "One", description: "Choose one." },
                            { label: "Two", description: "Choose two." },
                        ],
                        question: "Which choice should be used?",
                    },
                ],
            },
            { signal: controller.signal },
        );

        controller.abort();

        await expect(pending).rejects.toThrow("cancelled");
        expect(session.snapshot().pendingUserInputs).toEqual([]);
        expect(session.events.since(undefined)?.at(-1)).toMatchObject({
            data: { requestId: "question-1", status: "cancelled" },
            type: "user_input_resolved",
        });
    });
});

/** Two models on one provider that differ in the reasoning levels they accept. */
function configurableCatalog() {
    const slowModel = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/slow",
        name: "Slow model",
        thinkingLevels: ["off"],
    });
    const fastModel = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/fast",
        name: "Fast model",
        thinkingLevels: ["off", "high"],
    });
    const catalog: ModelCatalog = {
        defaultModelId: slowModel.id,
        defaultProviderId: "codex",
        models: [slowModel, fastModel],
        providers: [
            {
                providerId: "codex",
                providerType: "codex",
                models: [slowModel, fastModel],
                serviceTiers: ["fast"],
            },
        ],
    };
    return { fastModel, slowModel, store: new InMemorySessionStore({ modelCatalog: catalog }) };
}
