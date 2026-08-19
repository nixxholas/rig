import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymAgentEvent,
} from "@slopus/happy-agent-gym";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public transcript and run APIs", () => {
    it("keeps queued messages pending, accepts them in order, and pages whole runs", async () => {
        let releaseFirst!: () => void;
        let providerStarted!: () => void;
        const firstProviderStarted = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const firstProviderGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const gym = await startGym({
            inference: async (request) => {
                if (request.callIndex === 0) {
                    providerStarted();
                    await firstProviderGate;
                    return {
                        content: [{ text: "first answer", type: "text" }],
                        usage: {
                            cacheRead: 2,
                            cacheWrite: 3,
                            input: 11,
                            output: 7,
                            totalTokens: 23,
                        },
                    };
                }
                return {
                    content: [{ text: "second answer", type: "text" }],
                    usage: {
                        cacheRead: 5,
                        cacheWrite: 7,
                        input: 13,
                        output: 9,
                        totalTokens: 34,
                    },
                };
            },
        });

        const firstResponse = await gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            mutationId: "transcript-queue-first",
            text: "first question",
        });
        const firstStarted = await waitForStarted(
            gym,
            gym.defaultSessionId,
            firstResponse.message.id,
        );
        const firstRunId = runIdOf(firstStarted);
        if (firstRunId === undefined) throw new Error("The first run had no ID.");
        await firstProviderStarted;

        const secondResponse = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: modeFor(gym),
            mutationId: "transcript-queue-second",
            text: "second question",
        });
        expect(secondResponse.message).toMatchObject({
            delivery: "queue",
            id: expect.any(String),
            role: "user",
            runId: null,
            status: "pending",
        });

        const pending = await gym.client.getMessages(gym.defaultSessionId);
        expect(pending.pending.map((message) => message.id)).toContain(secondResponse.message.id);
        expect(pending.runs).toHaveLength(1);
        expect(pending.runs[0]?.id).toBe(firstRunId);

        releaseFirst();
        await waitForFinished(gym, gym.defaultSessionId, firstRunId);
        const secondStarted = await waitForStarted(
            gym,
            gym.defaultSessionId,
            secondResponse.message.id,
        );
        const secondRunId = runIdOf(secondStarted);
        if (secondRunId === undefined) throw new Error("The second run had no ID.");
        await waitForFinished(gym, gym.defaultSessionId, secondRunId);

        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.pending).toEqual([]);
        expect(history.runs.map((run) => run.id)).toEqual([firstRunId, secondRunId]);
        expect(history.runs.flatMap((run) => run.messages).map((message) => message.role)).toEqual([
            "user",
            "agent",
            "user",
            "agent",
        ]);
        expect(JSON.stringify(history.runs)).toContain("first question");
        expect(JSON.stringify(history.runs)).toContain("second answer");

        const newest = await gym.client.getMessages(gym.defaultSessionId, { limit: 1 });
        expect(newest.runs).toHaveLength(1);
        expect(newest.runs[0]?.id).toBe(secondRunId);
        expect(newest.hasMore).toBe(true);

        const older = await gym.client.getMessages(gym.defaultSessionId, {
            before: secondRunId,
            limit: 1,
        });
        expect(older.runs).toHaveLength(1);
        expect(older.runs[0]?.id).toBe(firstRunId);
        expect(older.hasMore).toBe(false);

        const runUsage = newest.runs[0]?.usage ?? {};
        expect(runUsage[gym.selection.providerId]?.[gym.selection.modelId]).toMatchObject({
            cacheRead: 5,
            cacheWrite: 7,
            input: 13,
            output: 9,
        });
        const usage = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(usage.usage[gym.selection.providerId]?.[gym.selection.modelId]).toMatchObject({
            cacheRead: 7,
            cacheWrite: 10,
            input: 24,
            output: 16,
        });
    }, 60_000);

    it("groups concurrent steering acceptances into one successor boundary", async () => {
        let releaseFirst!: () => void;
        let providerStarted!: () => void;
        const firstProviderStarted = new Promise<void>((resolve) => {
            providerStarted = resolve;
        });
        const firstProviderGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const gym = await startGym({
            inference: async (request) => {
                if (request.callIndex === 0) {
                    providerStarted();
                    await firstProviderGate;
                    return { content: [{ text: "obsolete answer", type: "text" }] };
                }
                return { content: [{ text: "steering answer", type: "text" }] };
            },
        });

        const first = await gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            mutationId: "transcript-steering-first",
            text: "start work",
        });
        const firstStarted = await waitForStarted(gym, gym.defaultSessionId, first.message.id);
        const firstRunId = runIdOf(firstStarted);
        if (firstRunId === undefined) throw new Error("The initial run had no ID.");
        await firstProviderStarted;

        const steeringRequests = [
            gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer" as const,
                mode: modeFor(gym),
                mutationId: "transcript-steering-one",
                text: "steer one",
            }),
            gym.client.sendMessage(gym.defaultSessionId, {
                delivery: "steer" as const,
                mode: modeFor(gym),
                mutationId: "transcript-steering-two",
                text: "steer two",
            }),
        ];
        const steeringIds = await waitForPendingMessageIds(gym, gym.defaultSessionId, [
            "steer one",
            "steer two",
        ]);

        releaseFirst();
        const steeringResponses = await Promise.all(steeringRequests);
        const steerOne = steeringResponses[0];
        const steerTwo = steeringResponses[1];
        if (steerOne === undefined || steerTwo === undefined) {
            throw new Error("Both steering requests must return a response.");
        }
        expect(steeringIds).toEqual(
            expect.arrayContaining([steerOne.message.id, steerTwo.message.id]),
        );

        const boundary = await gym.waitForEvent(
            (event) =>
                event.type === "run.boundary" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.acceptedMessageIds.length === 2 &&
                event.payload.acceptedMessageIds.includes(steerOne.message.id) &&
                event.payload.acceptedMessageIds.includes(steerTwo.message.id),
            "one boundary for both steering messages",
        );
        expect(boundary.type).toBe("run.boundary");
        if (boundary.type !== "run.boundary") throw new Error("Expected a run boundary.");
        expect(boundary.payload.finishedRun.id).toBe(firstRunId);
        expect(new Set(boundary.payload.acceptedMessageIds)).toEqual(
            new Set([steerOne.message.id, steerTwo.message.id]),
        );
        expect(boundary.payload.startedRun.id).not.toBe(firstRunId);

        await waitForFinished(gym, gym.defaultSessionId, boundary.payload.startedRun.id);
        const boundaries = (await gym.events()).filter(
            (event) =>
                event.type === "run.boundary" && event.payload.agentId === gym.defaultSessionId,
        );
        expect(boundaries).toHaveLength(1);

        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs.map((run) => run.id)).toEqual([
            firstRunId,
            boundary.payload.startedRun.id,
        ]);
        expect(JSON.stringify(history.runs)).toContain("steer one");
        expect(JSON.stringify(history.runs)).toContain("steer two");
    }, 60_000);

    it("guards aborts by run identity and records an aborted run", async () => {
        const gym = await startGym({
            inference: [
                {
                    content: [{ text: "long answer", type: "text" }],
                    delayMs: 10_000,
                },
            ],
        });

        const sent = await gym.client.sendMessage(gym.defaultSessionId, {
            mode: modeFor(gym),
            mutationId: "transcript-abort-send",
            text: "keep working",
        });
        const started = await waitForStarted(gym, gym.defaultSessionId, sent.message.id);
        const runId = runIdOf(started);
        if (runId === undefined) throw new Error("The active run had no ID.");

        await expect(
            gym.client.abortAgent(gym.defaultSessionId, {
                expectedRunId: "stalerun",
                mutationId: "transcript-abort-stale",
            }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.status).not.toBe("idle");

        const aborted = await gym.client.abortAgent(gym.defaultSessionId, {
            expectedRunId: runId,
            mutationId: "transcript-abort-current",
        });
        expect(aborted.agent.id).toBe(gym.defaultSessionId);
        const finished = await waitForFinished(gym, gym.defaultSessionId, runId);
        expect(finished.type).toBe("run.finished");
        if (finished.type !== "run.finished") throw new Error("Expected run.finished.");
        expect(finished.payload.run).toMatchObject({
            id: runId,
            reason: "abort",
            status: "aborted",
        });

        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]).toMatchObject({
            id: runId,
            reason: "abort",
            status: "aborted",
        });
    }, 60_000);

    it("aborts the targeted agent and its entire running descendant chain", async () => {
        let parentAgentId = "";
        let childAgentId: string | undefined;
        let grandchildAgentId: string | undefined;
        const callsByAgent = new Map<string, number>();
        const gym = await startGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Abort agent chain</title><slug>abort-agent-chain</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                const call = callsByAgent.get(request.sessionId) ?? 0;
                callsByAgent.set(request.sessionId, call + 1);
                if (request.sessionId === parentAgentId) {
                    return call === 0
                        ? {
                              content: [
                                  {
                                      arguments: {
                                          effort: "medium",
                                          model: "gym/model",
                                          text: "Create one descendant, then keep working.",
                                          title: "Abort chain child",
                                      },
                                      callId: "abortchainchild",
                                      name: "create_agent",
                                      type: "tool_call",
                                  },
                              ],
                          }
                        : {
                              content: [{ text: "parent still working", type: "text" }],
                              delayMs: 8_000,
                          };
                }
                if (childAgentId === undefined) {
                    childAgentId = request.sessionId;
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    text: "Keep working until the chain is stopped.",
                                    title: "Abort chain grandchild",
                                },
                                callId: "abortchaingrandchild",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (request.sessionId === childAgentId) {
                    return {
                        content: [{ text: "child still working", type: "text" }],
                        delayMs: 8_000,
                    };
                }
                grandchildAgentId = request.sessionId;
                return {
                    content: [{ text: "grandchild still working", type: "text" }],
                    delayMs: 8_000,
                };
            },
        });
        parentAgentId = gym.defaultSessionId;

        const accepted = await gym.send("Create a running descendant chain.", {
            permissionMode: "full_access",
            wait: false,
        });
        const descendants = await gym.waitUntil(async () => {
            const child = (await gym.client.getAgentActivity(parentAgentId)).subagents.find(
                (agent) => agent.status === "working",
            );
            if (child === undefined) return undefined;
            const grandchild = (await gym.client.getAgentActivity(child.id)).subagents.find(
                (agent) => agent.status === "working",
            );
            if (grandchild === undefined) return undefined;
            return { child, grandchild };
        }, "the complete descendant chain to be working");
        expect(childAgentId).toBe(descendants.child.id);
        expect(grandchildAgentId).toBe(descendants.grandchild.id);

        await gym.client.abortAgent(parentAgentId, {
            expectedRunId: accepted.runId,
            mutationId: "transcript-abort-chain",
        });

        const [finished, childRun, grandchildRun] = await Promise.all([
            waitForAborted(gym, parentAgentId, accepted.runId),
            waitForAbortedHistory(gym, descendants.child.id),
            waitForAbortedHistory(gym, descendants.grandchild.id),
        ]);
        expect(finished.payload.run.status).toBe("aborted");
        expect([childRun, grandchildRun]).toEqual([
            expect.objectContaining({ reason: "abort", status: "aborted" }),
            expect.objectContaining({ reason: "abort", status: "aborted" }),
        ]);
        await expect(gym.client.getAgent(parentAgentId)).resolves.toMatchObject({
            agent: { status: "idle", subagents: { running: 0 } },
        });
    }, 60_000);

    it("recovers message deltas, deletes reset content, omits tool data, and keeps compaction out of runs", async () => {
        const gym = await startGym({
            inference: [
                {
                    events: [
                        { type: "block_start" },
                        { type: "text_start" },
                        { delta: "discarded", type: "text_delta" },
                        { type: "block_reset" },
                        { type: "block_start" },
                        { type: "text_start" },
                        { delta: "fresh", type: "text_delta" },
                        { type: "text_end" },
                        { type: "block_stop" },
                        {
                            type: "token_usage",
                            usage: {
                                cacheRead: 1,
                                cacheWrite: 2,
                                input: 17,
                                output: 19,
                                totalTokens: 39,
                            },
                        },
                        {
                            state: "normal",
                            tokens: { input: 17, output: 19 },
                            type: "done",
                        },
                    ],
                },
                {
                    content: [
                        {
                            arguments: { cmd: "printf tool-result" },
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 23,
                        output: 11,
                        totalTokens: 34,
                    },
                },
                { content: [{ text: "final answer", type: "text" }] },
            ],
        });

        const stream = gym.stream();
        await stream.opened();
        const first = await gym.send("stream a resettable answer", {
            permissionMode: "full_access",
            mutationId: "transcript-delta-reset",
        });
        await waitForFinished(gym, gym.defaultSessionId, first.runId);

        const events = await gym.events();
        const agentEvents = events.filter((event) => agentIdOf(event) === gym.defaultSessionId);
        expect(agentEvents.some((event) => event.type === "message.delta")).toBe(true);
        expect(agentEvents.some((event) => event.type === "message.deleted")).toBe(true);
        expect(agentEvents.some((event) => event.type === "message.updated")).toBe(true);

        const firstHistory = await gym.client.getMessages(gym.defaultSessionId);
        const firstText = JSON.stringify(firstHistory.runs[0]?.messages ?? []);
        expect(firstText).toContain("fresh");
        expect(firstText).not.toContain("discarded");

        const beforeCompact = await gym.events();
        const compacted = await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "transcript-explicit-compaction",
        });
        expect(compacted.agent.id).toBe(gym.defaultSessionId);
        await gym.waitUntil(
            () => (gym.inference.compactions.length > 0 ? true : undefined),
            "explicit compaction to complete",
        );
        const afterCompact = await gym.events();
        const lifecycleBefore = beforeCompact.filter(
            (event) =>
                event.type === "run.started" ||
                event.type === "run.boundary" ||
                event.type === "run.finished",
        ).length;
        const lifecycleAfter = afterCompact.filter(
            (event) =>
                event.type === "run.started" ||
                event.type === "run.boundary" ||
                event.type === "run.finished",
        ).length;
        expect(lifecycleAfter).toBe(lifecycleBefore);

        const second = await gym.send("call a tool", {
            permissionMode: "full_access",
            mutationId: "transcript-tool-data",
        });
        await waitForFinished(gym, gym.defaultSessionId, second.runId);
        const full = await gym.client.getMessages(gym.defaultSessionId);
        const omitted = await gym.client.getMessages(gym.defaultSessionId, {
            omitToolData: true,
        });
        const fullTool = toolCallFrom(full);
        const omittedTool = toolCallFrom(omitted);
        expect(fullTool).toMatchObject({
            arguments: { cmd: "printf tool-result" },
            result: { output: expect.stringContaining("tool-result") },
        });
        expect(omittedTool).toMatchObject({ result: {} });
        expect(omittedTool).not.toHaveProperty("arguments");
        expect(omittedTool).not.toHaveProperty("result.output");

        const beforeRestart = await gym.client.getMessages(gym.defaultSessionId);
        const beforeUsage = await gym.client.getAgentUsage(gym.defaultSessionId);
        await gym.restart();
        const afterRestart = await gym.client.getMessages(gym.defaultSessionId);
        const afterUsage = await gym.client.getAgentUsage(gym.defaultSessionId);
        expect(afterRestart).toEqual(beforeRestart);
        expect(afterUsage).toEqual(beforeUsage);
        expect(gym.inference.unscripted).toEqual([]);
    }, 90_000);
});

async function startGym(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    activeGyms.add(gym);
    return gym;
}

function modeFor(gym: AgentGym) {
    return {
        effort: gym.selection.effort,
        modelId: gym.selection.modelId,
        permissionMode: "auto" as const,
        providerId: gym.selection.providerId,
        serviceTier: null,
    };
}

async function waitForStarted(
    gym: AgentGym,
    agentId: string,
    messageId: string,
): Promise<Extract<GymAgentEvent, { type: "run.started" | "run.boundary" }>> {
    return (await gym.waitForEvent(
        (event) =>
            (event.type === "run.started" || event.type === "run.boundary") &&
            event.payload.agentId === agentId &&
            event.payload.acceptedMessageIds.includes(messageId),
        `message ${messageId} to be accepted`,
    )) as Extract<GymAgentEvent, { type: "run.started" | "run.boundary" }>;
}

async function waitForFinished(
    gym: AgentGym,
    agentId: string,
    runId: string,
): Promise<Extract<GymAgentEvent, { type: "run.finished" | "run.boundary" }>> {
    return (await gym.waitForEvent(
        (event) =>
            (event.type === "run.finished" || event.type === "run.boundary") &&
            event.payload.agentId === agentId &&
            finishedRunId(event) === runId,
        `run ${runId} to finish`,
    )) as Extract<GymAgentEvent, { type: "run.finished" | "run.boundary" }>;
}

async function waitForAborted(
    gym: AgentGym,
    agentId: string,
    runId: string,
): Promise<Extract<GymAgentEvent, { type: "run.finished" }>> {
    return (await gym.waitForEvent(
        (event) =>
            event.type === "run.finished" &&
            event.payload.agentId === agentId &&
            event.payload.run.id === runId &&
            event.payload.run.status === "aborted" &&
            event.payload.run.reason === "abort",
        `run ${runId} in agent ${agentId} to be aborted`,
        10_000,
    )) as Extract<GymAgentEvent, { type: "run.finished" }>;
}

async function waitForAbortedHistory(gym: AgentGym, agentId: string) {
    return await gym.waitUntil(
        async () => {
            if ((await gym.client.getAgent(agentId)).agent.status !== "idle") return undefined;
            const run = (await gym.client.getMessages(agentId)).runs.at(-1);
            return run?.status === "aborted" && run.reason === "abort" ? run : undefined;
        },
        `the run in agent ${agentId} to be aborted`,
        10_000,
    );
}

async function waitForPendingMessageIds(
    gym: AgentGym,
    agentId: string,
    texts: readonly string[],
): Promise<readonly string[]> {
    return await gym.waitUntil(async () => {
        const history = await gym.client.getMessages(agentId);
        const ids = texts.map(
            (text) =>
                history.pending.find((message) =>
                    message.content.some((block) => block.type === "text" && block.text === text),
                )?.id,
        );
        return ids.every((id): id is string => id !== undefined) ? ids : undefined;
    }, "both steering messages to be pending");
}

function finishedRunId(
    event: Extract<GymAgentEvent, { type: "run.finished" | "run.boundary" }>,
): string {
    return event.type === "run.finished" ? event.payload.run.id : event.payload.finishedRun.id;
}

function agentIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const id = (payload as { readonly agentId?: unknown }).agentId;
    return typeof id === "string" ? id : undefined;
}

function toolCallFrom(history: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>) {
    for (const run of history.runs) {
        for (const message of run.messages) {
            const tool = message.content.find((block) => block.type === "tool_call");
            if (tool !== undefined) return tool;
        }
    }
    throw new Error("The history contained no tool call.");
}
