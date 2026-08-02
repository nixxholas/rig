import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import { defineModel } from "@slopus/rig-execution";

import type { GymInferenceRequest } from "../../executor/gym-types.js";
import type { ModelCatalog } from "../../protocol/index.js";
import { TrackedTaskDrain } from "../../utils/TrackedTaskDrain.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

const cleanups: (() => Promise<void>)[] = [];
const originalFetch = globalThis.fetch;
const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;

afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
    else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("persistent scheduling", () => {
    it("resumes a durable wait after daemon restart without replaying its call", async () => {
        const databasePath = await createDatabasePath();
        const requests: GymInferenceRequest[] = [];
        let now = 1_700_000_000_000;
        installGymInference((request) => {
            requests.push(request);
            return requests.length === 1
                ? {
                      content: [
                          {
                              arguments: { seconds: 10 },
                              id: "wait-provider-call",
                              name: "wait",
                              type: "toolCall",
                          },
                      ],
                  }
                : { content: [{ text: "WAIT_RESUMED", type: "text" }] };
        });

        let store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        const session = store.create(gymSessionRequest("/tmp/rig-durable-wait"));
        const submitted = session.submit({ text: "Wait ten seconds." });
        await vi.waitFor(() => expect(session.activity().kind).toBe("waiting"));

        await store.prepareForShutdown("shutdown");
        store.close();
        now += 11_000;

        store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        try {
            const restored = store.get(session.id);
            if (restored === undefined) throw new Error("Expected the waiting session.");
            await expect(restored.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1]?.context.messages)).toContain(
                "The wait completed after 11 seconds.",
            );
            expect(restored.snapshot().snapshot.messages).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        blocks: [expect.objectContaining({ text: "WAIT_RESUMED" })],
                        role: "agent",
                    }),
                ]),
            );
        } finally {
            store.close();
        }
    });

    it("aborts a durable wait by its restored run ID after daemon restart", async () => {
        const databasePath = await createDatabasePath();
        installGymInference(() => ({
            content: [
                {
                    arguments: { hours: 12 },
                    id: "restart-abort-provider-call",
                    name: "wait",
                    type: "toolCall",
                },
            ],
        }));

        let store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
        });
        const session = store.create(gymSessionRequest("/tmp/rig-restart-abort-wait"));
        const submitted = session.submit({ text: "Wait until I stop this run." });
        await vi.waitFor(() => expect(session.activity().kind).toBe("waiting"));

        await store.prepareForShutdown("shutdown");
        store.close();

        store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
        });
        try {
            const restored = store.get(session.id);
            if (restored === undefined) throw new Error("Expected the waiting session.");
            await expect(restored.abort({ expectedRunId: submitted.runId })).resolves.toMatchObject(
                {
                    aborted: true,
                },
            );
            expect(restored.activity().kind).not.toBe("waiting");
            expect(restored.state().activeRunId).toBeUndefined();
        } finally {
            await store.prepareForShutdown("shutdown");
            store.close();
        }
    });

    it("ends a long wait when a message arrives and reports actual elapsed time", async () => {
        const requests: GymInferenceRequest[] = [];
        let now = 1_700_000_000_000;
        installGymInference((request) => {
            requests.push(request);
            return requests.length === 1
                ? {
                      content: [
                          {
                              arguments: { hours: 12 },
                              id: "long-wait-provider-call",
                              name: "wait",
                              type: "toolCall",
                          },
                      ],
                  }
                : { content: [{ text: "WAIT_INTERRUPTED", type: "text" }] };
        });
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        try {
            const session = store.create(gymSessionRequest("/tmp/rig-interrupted-wait"));
            const submitted = session.submit({ text: "Wait for twelve hours." });
            await vi.waitFor(() => expect(session.activity().kind).toBe("waiting"));

            now += 3_250;
            session.steer({ expectedRunId: submitted.runId, text: "Stop waiting now." });

            await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(2);
            const resumedContext = JSON.stringify(requests[1]?.context.messages);
            expect(resumedContext).toContain(
                "The wait ended early because a new message arrived after 3.25 seconds.",
            );
            expect(resumedContext).toContain("Stop waiting now.");
            expect(session.activity().kind).toBe("idle");
        } finally {
            await store.prepareForShutdown("shutdown");
            store.close();
        }
    });

    it("carries the live wait on the catalog session summary until it ends", async () => {
        const requests: GymInferenceRequest[] = [];
        let now = 1_700_000_000_000;
        installGymInference((request) => {
            requests.push(request);
            return requests.length === 1
                ? {
                      content: [
                          {
                              arguments: { hours: 12 },
                              id: "catalog-wait-provider-call",
                              name: "wait",
                              type: "toolCall",
                          },
                      ],
                  }
                : { content: [{ text: "CATALOG_WAIT_DONE", type: "text" }] };
        });
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        try {
            const session = store.create(gymSessionRequest("/tmp/rig-catalog-wait"));
            const submitted = session.submit({ text: "Wait for twelve hours." });
            await vi.waitFor(() => expect(session.activity().kind).toBe("waiting"));

            // Activity is live-only, so the catalog summary is what tells a
            // client connecting mid-wait that the session is waiting. It must
            // state the same span the live activity reports.
            const waiting = store.listActive().find((summary) => summary.id === session.id);
            const wait = waiting?.wait;
            if (wait === undefined) throw new Error("Expected the summary to carry the wait.");
            expect(wait).toEqual(session.activity().wait);
            expect(wait.dueAt - wait.startedAt).toBe(12 * 60 * 60 * 1000);

            now += 3_000;
            session.steer({ expectedRunId: submitted.runId, text: "Stop waiting now." });
            await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
                status: "completed",
            });

            const settled = store.listActive().find((summary) => summary.id === session.id);
            expect(settled).toBeDefined();
            expect(settled?.wait).toBeUndefined();
        } finally {
            await store.prepareForShutdown("shutdown");
            store.close();
        }
    });

    it("continues a restored wait before running the message that interrupts it", async () => {
        const databasePath = await createDatabasePath();
        const requests: GymInferenceRequest[] = [];
        let now = 1_700_000_000_000;
        installGymInference((request) => {
            requests.push(request);
            if (requests.length === 1) {
                return {
                    content: [
                        {
                            arguments: { hours: 12 },
                            id: "restored-wait-provider-call",
                            name: "wait",
                            type: "toolCall",
                        },
                    ],
                };
            }
            if (requests.length === 2) {
                expect(JSON.stringify(request.context.messages)).toContain(
                    "The wait ended early because a new message arrived after 2 seconds.",
                );
                return { content: [{ text: "RESTORED_WAIT_CONTINUED", type: "text" }] };
            }
            return { content: [{ text: "INTERRUPTING_MESSAGE_COMPLETED", type: "text" }] };
        });

        let store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        const session = store.create(gymSessionRequest("/tmp/rig-restored-wait-interruption"));
        const waitingRun = session.submit({ text: "Wait for twelve hours." });
        await vi.waitFor(() => expect(session.activity().kind).toBe("waiting"));
        await store.prepareForShutdown("shutdown");
        store.close();

        now += 2_000;
        const taskDrain = new TrackedTaskDrain();
        store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
            taskDrain,
        });
        try {
            const restored = store.get(session.id);
            if (restored === undefined) throw new Error("Expected the restored waiting session.");
            expect(restored.activity().kind).toBe("waiting");
            const interruptingRun = restored.submit({ text: "Stop waiting after restart." });

            await expect(restored.waitForRun(waitingRun.runId)).resolves.toEqual({
                status: "completed",
            });
            await expect(restored.waitForRun(interruptingRun.runId)).resolves.toEqual({
                status: "completed",
            });
            expect(requests).toHaveLength(3);
            expect(
                restored
                    .snapshot()
                    .snapshot.messages.filter((message) => message.role === "agent")
                    .map((message) => message.blocks)
                    .flat(),
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ text: "RESTORED_WAIT_CONTINUED" }),
                    expect.objectContaining({ text: "INTERRUPTING_MESSAGE_COMPLETED" }),
                ]),
            );
        } finally {
            await store.prepareForShutdown("shutdown");
            store.close();
        }
    });

    it("delivers scheduled messages by Agent ID and retains failed delivery", async () => {
        installGymInference(() => ({ content: [{ text: "MESSAGE_RECEIVED", type: "text" }] }));
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            modelCatalog: gymCatalog(),
        });
        try {
            const sender = store.create(gymSessionRequest("/tmp/rig-schedule-sender"));
            const target = store.create(gymSessionRequest("/tmp/rig-schedule-target"));
            const delivered = sender.scheduleMessage({
                dueAt: Date.now(),
                message: "Run the scheduled check.",
                targetAgentId: target.snapshot().agentId,
            });
            const retained = sender.scheduleMessage({
                dueAt: Date.now(),
                message: "This target is unavailable.",
                targetAgentId: "unknown-agent-id",
            });

            await vi.waitFor(() => {
                expect(sender.scheduledMessages()).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ id: delivered.id, status: "delivered" }),
                        expect.objectContaining({ id: retained.id, status: "undelivered" }),
                    ]),
                );
            });
            expect(
                target
                    .snapshot()
                    .snapshot.messages.some(
                        (message) =>
                            message.role === "user" &&
                            message.id === delivered.id &&
                            message.agentSource?.agentId === sender.snapshot().agentId,
                    ),
            ).toBe(true);
            expect(
                sender.scheduledMessages().find((message) => message.id === retained.id)?.failure,
            ).toContain("No available agent");
        } finally {
            await store.prepareForShutdown("shutdown");
            store.close();
        }
    });

    it("keeps cancelled scheduled messages across restart without delivering them", async () => {
        const databasePath = await createDatabasePath();
        let now = 1_700_000_000_000;
        let store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        const sender = store.create(gymSessionRequest("/tmp/rig-schedule-cancel"));
        const scheduled = sender.scheduleMessage({
            dueAt: now + 60_000,
            message: "Do not deliver this.",
            targetAgentId: sender.snapshot().agentId,
        });
        expect(sender.cancelScheduledMessage(scheduled.id)).toMatchObject({ cancelled: true });
        store.close();
        now += 120_000;

        store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        try {
            const restored = store.get(sender.id);
            expect(restored?.scheduledMessages()).toEqual([
                expect.objectContaining({ id: scheduled.id, status: "cancelled" }),
            ]);
            expect(
                restored
                    ?.snapshot()
                    .snapshot.messages.some((message) => message.id === scheduled.id),
            ).toBe(false);
        } finally {
            store.close();
        }
    });

    it("bounds settled schedule history while retaining pending and failed deliveries", async () => {
        const databasePath = await createDatabasePath();
        let now = 1_700_000_000_000;
        let store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        const sender = store.create(gymSessionRequest("/tmp/rig-schedule-retention"));
        const pending = sender.scheduleMessage({
            dueAt: now + 86_400_000,
            message: "Keep this pending.",
            targetAgentId: sender.snapshot().agentId,
        });
        const failed = sender.scheduleMessage({
            dueAt: now + 86_400_000,
            message: "Keep this failed delivery.",
            targetAgentId: "unavailable-agent",
        });
        sender.deliverScheduledMessage(failed.id);

        const scheduleEvents: unknown[] = [];
        const unsubscribe = sender.events.subscribe((event) => {
            if ((event.type as string) === "scheduled_messages_pruned") {
                scheduleEvents.push(event.data);
            }
        });
        for (let index = 0; index <= 1_000; index += 1) {
            const scheduled = sender.scheduleMessage({
                dueAt: now + 86_400_000,
                message: `Settled message ${String(index)}`,
                targetAgentId: sender.snapshot().agentId,
            });
            sender.cancelScheduledMessage(scheduled.id);
        }
        unsubscribe();

        expect(sender.scheduledMessages()).toHaveLength(1_002);
        expect(sender.scheduledMessages().map((message) => message.id)).toEqual(
            expect.arrayContaining([pending.id, failed.id]),
        );
        expect(scheduleEvents).toEqual([
            {
                messageIds: [
                    expect.not.stringMatching(new RegExp(`^(${pending.id}|${failed.id})$`)),
                ],
            },
        ]);
        const beforeRestart = sender.scheduledMessages();
        store.close();

        store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        try {
            const restored = store.get(sender.id);
            expect(restored?.scheduledMessages()).toHaveLength(1_002);
            expect(restored?.scheduledMessages()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: pending.id, status: "pending" }),
                    expect.objectContaining({ id: failed.id, status: "undelivered" }),
                ]),
            );
            expect(restored?.scheduledMessages()).toEqual(beforeRestart);
        } finally {
            store.close();
        }
        // A thousand settled schedules are a thousand committed writes, and a
        // loaded CI machine flushes them far more slowly than a local disk.
    }, 60_000);

    it("delivers a scheduled message after the daemon and sender have stopped", async () => {
        installGymInference(() => ({ content: [{ text: "RESTARTED_DELIVERY", type: "text" }] }));
        const databasePath = await createDatabasePath();
        let now = 1_700_000_000_000;
        let store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        const sender = store.create(gymSessionRequest("/tmp/rig-schedule-restart-sender"));
        const target = store.create(gymSessionRequest("/tmp/rig-schedule-restart-target"));
        const scheduled = sender.scheduleMessage({
            dueAt: now + 60_000,
            message: "Deliver after restart.",
            targetAgentId: target.snapshot().agentId,
        });

        await store.prepareForShutdown("shutdown");
        store.close();
        now += 120_000;

        store = new PersistentSessionStore({
            databasePath,
            modelCatalog: gymCatalog(),
            now: () => now,
        });
        try {
            const restoredSender = store.get(sender.id);
            const restoredTarget = store.get(target.id);
            if (restoredSender === undefined || restoredTarget === undefined) {
                throw new Error("Expected both scheduled sessions after restart.");
            }
            await vi.waitFor(() => {
                expect(restoredSender.scheduledMessages()).toEqual([
                    expect.objectContaining({ id: scheduled.id, status: "delivered" }),
                ]);
            });
            expect(
                restoredTarget
                    .snapshot()
                    .snapshot.messages.some((message) => message.id === scheduled.id),
            ).toBe(true);
        } finally {
            await store.prepareForShutdown("shutdown");
            store.close();
        }
    });
});

function installGymInference(
    response: (request: GymInferenceRequest) => {
        content: readonly unknown[];
        stopReason?: string;
    },
): void {
    process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
    globalThis.fetch = async (_input, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
        const request = JSON.parse(init.body) as GymInferenceRequest;
        if (request.options.sessionId?.endsWith(":title")) {
            return jsonResponse({
                content: [
                    { text: '{"title":"Scheduled session","recap":"Scheduling"}', type: "text" },
                ],
                stopReason: "stop",
            });
        }
        return jsonResponse(response(request));
    };
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}

function gymCatalog(): ModelCatalog {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/gym",
        name: "Gym",
        thinkingLevels: ["off"],
    });
    return {
        defaultModelId: model.id,
        defaultProviderId: "gym",
        models: [model],
        providers: [{ models: [model], providerId: "gym" }],
    };
}

function gymSessionRequest(cwd: string) {
    return {
        cwd,
        modelId: "openai/gym",
        permissionMode: "full_access" as const,
        providerId: "gym",
    };
}

async function createDatabasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "rig-scheduling-test-"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return join(directory, "sessions.sqlite");
}
