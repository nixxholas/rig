import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    UserInputFeature,
    formatUserInputPageForModel,
    formatUserInputForModel,
    type UserInputEvent,
    type UserInputRequest,
    type UserInputStore,
    userInputAnswerInputSchema,
    userInputAnswerSchema,
    userInputRequestSchema,
    userInputToolInputSchema,
    userInputTerminalRequestSchema,
} from "../../sources/userInput/index.js";
import { UserInputTestStore } from "./UserInputTestStore.js";
import { agentWorld } from "../support/agentWorld.js";

const root = createRootContext().named("user-input-test");
const agent = "agent-a";
const otherAgent = "agent-b";

function makeFeature(
    store: UserInputTestStore,
    options: {
        readonly events?: UserInputEvent[];
        readonly postEvents?: UserInputEvent[];
        readonly available?: boolean;
        readonly authorize?: boolean;
        readonly transactionalFailure?: boolean;
        readonly maxOutputCharacters?: number;
        readonly maxContextCharacters?: number;
    } = {},
): UserInputFeature {
    let identity = 0;
    let eventIdentity = 0;
    return new UserInputFeature({
        store,
        idFactory: () => `id-${++identity}`,
        eventIdFactory: () => `event-${++eventIdentity}`,
        clock: () => 1_000 + eventIdentity,
        ...(options.available === undefined
            ? {}
            : { presence: { isAvailable: async () => options.available! } }),
        ...(options.authorize === undefined
            ? {}
            : { authorization: { authorize: async () => options.authorize! } }),
        ...(options.maxOutputCharacters === undefined
            ? {}
            : { maxOutputCharacters: options.maxOutputCharacters }),
        ...(options.maxContextCharacters === undefined
            ? {}
            : { maxContextCharacters: options.maxContextCharacters }),
        listener: {
            ...(options.transactionalFailure
                ? {
                      onEventTransactional: async () => {
                          throw new Error("transactional listener failure");
                      },
                  }
                : {
                      onEventTransactional: async (_ctx, event) => {
                          options.events?.push(event);
                      },
                  }),
            onEvent: async (_ctx, event) => {
                options.postEvents?.push(event);
            },
        },
    });
}

function callContext(persistence: ReturnType<typeof agentWorld>["storage"], name = agent): Context {
    return withAgentKV(
        root,
        new AgentKV(persistence.persistence(name), "user-input-call."),
    );
}

async function createPending(
    feature: UserInputFeature,
    ctx: Context = root,
): Promise<UserInputRequest> {
    return await feature.ask(ctx, agent, {
        operationId: "ask-op",
        question: "Should this ship?",
        context: "# Decision\n\nChoose the safest option.",
    });
}

describe("UserInputFeature", () => {
    it("exports a TypeBox request schema and a single durable common tool", () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        const tools = feature.tools(root, { agent: { id: agent } } as never);
        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("request_user_input");
        expect(tools[0]?.durable).toBe(true);
        expect(tools[0]?.shouldReviewInAutoMode({ question: "q", context: "c" }, root)).toBe(
            false,
        );
        expect(Value.Check(userInputToolInputSchema, { question: "q", context: "c" })).toBe(true);
        expect(
            Value.Check(userInputAnswerInputSchema, {
                requestId: "id",
                answer: "yes",
            }),
        ).toBe(true);
        expect(Value.Check(userInputAnswerSchema, {})).toBe(false);
    });

    it("asks, waits, answers, and renders the same public result through the tool", async () => {
        const store = new UserInputTestStore();
        const events: UserInputEvent[] = [];
        const postEvents: UserInputEvent[] = [];
        const feature = makeFeature(store, { events, postEvents });
        const world = agentWorld();
        const ctx = callContext(world.storage);
        const tool = feature.tools(ctx, { agent: { id: agent } } as never)[0]!;

        const toolPromise = tool.execute(ctx, {
            question: "Ship it?",
            context: "## Context\n\nThe human may only see this document.",
        });
        await vi.waitFor(() => expect(store.requests.size).toBe(1));
        const request = [...store.requests.values()][0]!;
        expect(request.status).toBe("pending");
        expect(Value.Check(userInputTerminalRequestSchema, request)).toBe(false);
        const answered = await feature.answer(root, otherAgent, {
            operationId: "answer-op",
            requestId: request.id,
            answer: "yes",
        }).catch(async (error: unknown) => {
            // The default authorization policy denies the cross-agent answer; this branch keeps
            // the test explicit and then answers as the requesting agent.
            expect(error).toBeInstanceOf(Error);
            return await feature.answer(root, agent, {
                operationId: "answer-op",
                requestId: request.id,
                answer: "yes",
            });
        });
        expect(answered.status).toBe("answered");
        const result = await toolPromise;
        expect(result.status).toBe("answered");
        expect(Value.Check(userInputTerminalRequestSchema, result)).toBe(true);
        expect(result).toEqual(await feature.get(root, agent, request.id));
        expect(feature.formatForModel(result)).toContain("Answered");
        expect(events.map((event) => event.type)).toEqual([
            "user_input_requested",
            "user_input_answered",
        ]);
        expect(postEvents).toEqual(events);
        expect(Value.Check(userInputRequestSchema, result)).toBe(true);
    });

    it("keeps a structured selection visible before long answer prose and exposes detail", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store, { maxOutputCharacters: 256 });
        const request = await feature.ask(root, agent, {
            operationId: "structured-answer-ask",
            question: "Choose an outcome.",
            context: "The explanation may be long.",
            options: {
                multiSelect: false,
                choices: [{ label: "accept", description: "Accept the proposal." }],
            },
        });
        const answered = await feature.answer(root, agent, {
            operationId: "structured-answer",
            requestId: request.id,
            answer: {
                text: "p".repeat(2_000),
                selectedOptions: ["accept"],
            },
        });
        const tool = feature.tools(root, { agent: { id: agent } } as never)[0]!;
        const rendered = (tool.toLLM(answered)[0] as { type: "text"; text: string }).text;
        expect(rendered.length).toBeLessThanOrEqual(256);
        expect(rendered).toContain("Selected options: accept.");
        expect(rendered.indexOf("Selected options:")).toBeLessThan(
            rendered.indexOf("Explanation:"),
        );
        expect(rendered).toContain("More detail: call request_user_input");

        const detail = await tool.execute(root, {
            requestId: answered.id,
            cursor: "0",
        });
        const detailText = (tool.toLLM(detail)[0] as { type: "text"; text: string }).text;
        expect(detailText).toContain("Selected options: accept.");
        expect(detailText).toContain("Explanation:");
    });

    it("keeps formatted page traversal strictly advancing across cursor and budget shapes", () => {
        const counts = [0, 1, 2, 7, 17, 53, 101, 200];
        const limits = [1, 2, 7, 100];
        const budgets = [256, 320, 512];

        for (const count of counts) {
            const records: UserInputRequest[] = Array.from({ length: count }, (_, index) => ({
                id: `request-${String(index).padStart(3, "0")}`,
                askingAgentId: agent,
                question: "A listed request.",
                context: "A listed request context.",
                status: "pending",
                createdAt: 1_000,
                updatedAt: 1_000,
            }));
            const requestedCursors = [
                0,
                1,
                Math.floor(count / 4),
                Math.floor(count / 2),
                Math.floor((count * 3) / 4),
                Math.max(0, count - 1),
                count,
            ].filter((cursor, index, values) => values.indexOf(cursor) === index);

            for (const requestedCursor of requestedCursors) {
                for (const limit of limits) {
                    for (const budget of budgets) {
                        let cursor = requestedCursor;
                        const expectedIds = records.slice(requestedCursor).map((record) => record.id);
                        const visitedIds: string[] = [];
                        const visitedCursors = new Set<number>();
                        let finished = false;

                        for (let step = 0; step <= count + 1; step += 1) {
                            expect(visitedCursors.has(cursor)).toBe(false);
                            visitedCursors.add(cursor);
                            const rows = records.slice(cursor, cursor + limit);
                            const nextFromStore =
                                cursor + rows.length < count
                                    ? String(cursor + rows.length)
                                    : undefined;
                            const page = {
                                requests: rows,
                                cursor: String(cursor),
                                limit,
                                ...(cursor === 0
                                    ? {}
                                    : { previousCursor: String(Math.max(0, cursor - limit)) }),
                                ...(nextFromStore === undefined
                                    ? {}
                                    : { nextCursor: nextFromStore }),
                            };
                            const rendered = formatUserInputPageForModel(page, budget);
                            const visibleIds = rendered
                                .split("\n")
                                .filter((line) => line.includes(" — Outcome:"))
                                .map((line) => line.split(" — Outcome:")[0]!);
                            for (const id of visibleIds) {
                                expect(expectedIds).toContain(id);
                                expect(visitedIds).not.toContain(id);
                                visitedIds.push(id);
                            }
                            const nextMatch = rendered.match(/More requests at cursor ([0-9]+)\./);
                            if (nextMatch === null) {
                                finished = true;
                                break;
                            }
                            const next = Number(nextMatch[1]);
                            expect(next).toBeGreaterThan(cursor);
                            expect(next).toBeLessThanOrEqual(count);
                            cursor = next;
                        }

                        expect(finished).toBe(true);
                        expect(visitedIds).toEqual(expectedIds);
                    }
                }
            }
        }
    });

    it("allows an authorized agent to mutate and wait for another agent's request", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store, { authorize: true });
        const request = await createPending(feature);
        const waiting = feature.wait(root, otherAgent, {
            operationId: "cross-agent-wait",
            requestId: request.id,
        });
        await vi.waitFor(() => expect(store.calls).toContain("wait"));
        const answered = await feature.answer(root, otherAgent, {
            operationId: "cross-agent-answer",
            requestId: request.id,
            answer: "yes",
        });
        await expect(waiting).resolves.toEqual(answered);
        expect(answered.askingAgentId).toBe(agent);
    });

    it("re-attaches a retried durable call after a fresh feature instance", async () => {
        const store = new UserInputTestStore();
        const world = agentWorld();
        const ctx = callContext(world.storage);
        const first = makeFeature(store);
        const firstTool = first.tools(ctx, { agent: { id: agent } } as never)[0]!;
        const firstRun = firstTool.execute(ctx, {
            question: "Continue?",
            context: "Restart-safe context.",
        });
        await vi.waitFor(() => expect(store.requests.size).toBe(1));
        const request = [...store.requests.values()][0]!;
        expect(request.status).toBe("pending");

        // Recreate the feature while both durable calls are still waiting.
        const second = makeFeature(store);
        const secondTool = second.tools(ctx, { agent: { id: agent } } as never)[0]!;
        const retryRun = secondTool.execute(ctx, {
            question: "Continue?",
            context: "Restart-safe context.",
        });
        await vi.waitFor(() => {
            expect(store.calls.filter((call) => call === "wait")).toHaveLength(2);
        });
        expect(
            await Promise.race([
                retryRun.then(() => "resolved"),
                Promise.resolve("pending"),
            ]),
        ).toBe("pending");

        const terminal: UserInputRequest = {
            ...request,
            status: "answered",
            answer: { text: "yes" },
            answeredAt: 1_001,
            updatedAt: 1_001,
        };
        store.settle(terminal);

        const [firstResult, retry] = await Promise.all([
            firstRun,
            retryRun,
        ]);
        expect(firstResult.status).toBe("answered");
        expect(retry).toEqual(firstResult);
        expect([...store.requests.keys()]).toEqual([request.id]);
        expect(store.requests.size).toBe(1);
    });

    it("requires host-facing mutations to carry operation identities", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        await expect(
            feature.ask(root, agent, {
                question: "Missing identity?",
                context: "The host must identify this call.",
            }),
        ).rejects.toThrow("operation identity");
        const world = agentWorld();
        const featureScopedContext = withAgentKV(
            root,
            new AgentKV(world.storage.persistence(agent), "feature-scoped-user-input."),
        );
        await expect(
            feature.ask(featureScopedContext, agent, {
                question: "Feature scope?",
                context: "A feature-scoped KV is not a tool call.",
            }),
        ).rejects.toThrow("operation identity");
        const request = await feature.ask(root, agent, {
            operationId: "host-ask-operation",
            question: "Host retry?",
            context: "The receipt binds the request identity.",
        });
        const retry = await feature.ask(root, agent, {
            operationId: "host-ask-operation",
            question: "Host retry?",
            context: "The receipt binds the request identity.",
        });
        expect(retry).toEqual(request);
    });

    it("hashes legal large contexts and atomically reuses concurrent host ask identities", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        const context = "x".repeat(70_000);
        const large = await feature.ask(root, agent, {
            operationId: "large-host-context",
            question: "Keep this context?",
            context,
        });
        expect(large.context).toBe(context);

        const input = {
            operationId: "concurrent-host-ask",
            question: "One durable request?",
            context: "Both callers use the same operation identity.",
        } as const;
        const [first, second] = await Promise.all([
            feature.ask(root, agent, input),
            feature.ask(root, agent, input),
        ]);
        expect(second).toEqual(first);
        expect(store.requests.size).toBe(2);
        expect(
            [...store.receipts.values()].filter(
                (receipt) => receipt.operationId === input.operationId,
            ),
        ).toHaveLength(1);
    });

    it("records unchanged proof data when ask recovers an existing request", async () => {
        const store = new UserInputTestStore();
        const events: UserInputEvent[] = [];
        const existing: UserInputRequest = {
            id: "id-1",
            askingAgentId: agent,
            question: "Recover this request?",
            context: "The row already exists.",
            status: "pending",
            createdAt: 1_000,
            updatedAt: 1_000,
        };
        store.requests.set(existing.id, existing);
        const feature = makeFeature(store, { events });
        await expect(
            feature.ask(root, agent, {
                operationId: "recover-existing-ask",
                question: existing.question,
                context: existing.context,
            }),
        ).resolves.toEqual(existing);
        expect(events).toHaveLength(0);
        expect(store.proofs.get(`${agent}:recover-existing-ask`)).toMatchObject({
            before: existing,
            after: existing,
            changed: false,
        });
        expect(store.receipts.get(`${agent}:recover-existing-ask`)).toMatchObject({
            changed: false,
            result: existing,
        });
    });

    it("rejects malformed persisted rows and keeps broker waits outside transactions", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        store.requests.set("bad", { status: "pending" } as never);
        await expect(feature.get(root, agent, "bad")).rejects.toThrow("invalid request");

        store.requests.clear();
        const request = await createPending(feature);
        const waiting = feature.wait(root, agent, { requestId: request.id, operationId: "wait-op" });
        await vi.waitFor(() => expect(store.calls).toContain("wait"));
        expect(store.waitCalledInsideTransaction).toBe(false);
        store.settle({
            ...request,
            status: "away",
            completedAt: 1_010,
            updatedAt: 1_010,
        });
        await expect(waiting).resolves.toMatchObject({ status: "away" });
    });

    it("binds substituted request, receipt, and proof identities to the requested operation", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        const request = await createPending(feature);
        const originalRead = store.readRequest.bind(store);
        const readSpy = vi.spyOn(store, "readRequest").mockImplementation(async (ctx, requestId) => {
            const value = await originalRead(ctx, requestId);
            return value === undefined ? undefined : { ...value, id: "substituted-request" };
        });
        await expect(feature.get(root, agent, request.id)).rejects.toThrow("different identity");
        readSpy.mockRestore();

        const proofKey = `${agent}:ask-op`;
        const receiptKey = `${agent}:ask-op`;
        const proof = store.proofs.get(proofKey);
        const receipt = store.receipts.get(receiptKey);
        expect(proof).toBeDefined();
        expect(receipt).toBeDefined();
        const originalRequest = store.requests.get(request.id);
        expect(originalRequest).toEqual(request);
        store.requests.set(request.id, {
            ...request,
            askingAgentId: otherAgent,
        });
        await expect(
            feature.ask(root, agent, {
                operationId: "ask-op",
                question: "Should this ship?",
                context: "# Decision\n\nChoose the safest option.",
            }),
        ).rejects.toThrow("ask receipt disagrees");
        store.requests.set(request.id, originalRequest!);
        store.proofs.set(proofKey, { ...proof!, actingAgentId: otherAgent });
        await expect(
            feature.ask(root, agent, {
                operationId: "ask-op",
                question: "Should this ship?",
                context: "# Decision\n\nChoose the safest option.",
            }),
        ).rejects.toThrow("different operation");
        store.proofs.set(proofKey, proof!);
        store.proofs.set(proofKey, {
            ...proof!,
            before: proof!.after,
            changed: false,
        });
        await expect(
            feature.ask(root, agent, {
                operationId: "ask-op",
                question: "Should this ship?",
                context: "# Decision\n\nChoose the safest option.",
            }),
        ).rejects.toThrow("receipt and mutation proof disagree");
        store.proofs.set(proofKey, proof!);
        store.receipts.set(receiptKey, {
            ...receipt!,
            result: { ...receipt!.result, id: "substituted-request" },
        });
        await expect(
            feature.ask(root, agent, {
                operationId: "ask-op",
                question: "Should this ship?",
                context: "# Decision\n\nChoose the safest option.",
            }),
        ).rejects.toThrow("different input");
    });

    it("settles away and timeout outcomes without a host timer", async () => {
        const awayStore = new UserInputTestStore();
        const awayFeature = makeFeature(awayStore, { available: false });
        const awayRequest = await createPending(awayFeature);
        await expect(
            awayFeature.wait(root, agent, {
                operationId: "away-wait",
                requestId: awayRequest.id,
            }),
        ).resolves.toMatchObject({ status: "away" });

        const timeoutStore = new UserInputTestStore();
        const timeoutFeature = makeFeature(timeoutStore);
        const timeoutRequest = await timeoutFeature.ask(root, agent, {
            operationId: "timeout-ask",
            question: "Expired?",
            context: "This deadline has elapsed.",
            deadlineAt: 1_000,
        });
        await expect(
            timeoutFeature.wait(root, agent, {
                operationId: "timeout-wait",
                requestId: timeoutRequest.id,
            }),
        ).resolves.toMatchObject({ status: "timed_out", deadlineAt: 1_000 });
    });

    it("publishes one terminal event when concurrent waits are awakened by completion", async () => {
        const store = new UserInputTestStore();
        const events: UserInputEvent[] = [];
        const postEvents: UserInputEvent[] = [];
        const feature = makeFeature(store, { events, postEvents });
        const request = await createPending(feature);
        const firstWait = feature.wait(root, agent, {
            operationId: "concurrent-wait-a",
            requestId: request.id,
        });
        const secondWait = feature.wait(root, agent, {
            operationId: "concurrent-wait-b",
            requestId: request.id,
        });
        await vi.waitFor(() => {
            expect(store.calls.filter((call) => call === "wait")).toHaveLength(2);
        });

        const completed = await feature.complete(root, agent, {
            operationId: "complete-away-for-waits",
            requestId: request.id,
            outcome: "away",
        });
        await expect(firstWait).resolves.toEqual(completed);
        await expect(secondWait).resolves.toEqual(completed);
        expect(events.filter((event) => event.type === "user_input_completed")).toHaveLength(1);
        expect(postEvents.filter((event) => event.type === "user_input_completed")).toHaveLength(1);
        expect(postEvents.find((event) => event.type === "user_input_completed")).toBe(
            events.find((event) => event.type === "user_input_completed"),
        );
    });

    it("requires an existing, matching, elapsed deadline for timeout completion", async () => {
        const noDeadlineStore = new UserInputTestStore();
        const noDeadlineFeature = makeFeature(noDeadlineStore);
        const noDeadline = await createPending(noDeadlineFeature);
        await expect(
            noDeadlineFeature.complete(root, agent, {
                operationId: "timeout-without-deadline",
                requestId: noDeadline.id,
                outcome: "timed_out",
                deadlineAt: 1_000,
            }),
        ).rejects.toThrow("no timeout deadline");
        await noDeadlineFeature.complete(root, agent, {
            operationId: "complete-without-deadline",
            requestId: noDeadline.id,
            outcome: "away",
        });
        await expect(
            noDeadlineFeature.complete(root, agent, {
                operationId: "terminal-timeout-without-deadline",
                requestId: noDeadline.id,
                outcome: "timed_out",
                deadlineAt: 1_000,
            }),
        ).rejects.toThrow("no timeout deadline");

        const futureStore = new UserInputTestStore();
        const futureFeature = makeFeature(futureStore);
        const future = await futureFeature.ask(root, agent, {
            operationId: "future-timeout-ask",
            question: "Not yet?",
            context: "The deadline is still ahead.",
            deadlineAt: 2_000,
        });
        await expect(
            futureFeature.complete(root, agent, {
                operationId: "future-timeout",
                requestId: future.id,
                outcome: "timed_out",
                deadlineAt: 2_000,
            }),
        ).rejects.toThrow("has not elapsed");

        const mismatchStore = new UserInputTestStore();
        const mismatchFeature = makeFeature(mismatchStore);
        const mismatch = await mismatchFeature.ask(root, agent, {
            operationId: "mismatch-timeout-ask",
            question: "Which deadline?",
            context: "The supplied deadline must match.",
            deadlineAt: 1_000,
        });
        await expect(
            mismatchFeature.complete(root, agent, {
                operationId: "mismatch-timeout",
                requestId: mismatch.id,
                outcome: "timed_out",
                deadlineAt: 999,
            }),
        ).rejects.toThrow("does not match");
    });

    it("rejects persisted timeout rows whose timestamp precedes the deadline", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        store.requests.set("malformed-timeout", {
            id: "malformed-timeout",
            askingAgentId: agent,
            question: "Malformed timeout?",
            context: "The timeout timestamp is invalid.",
            deadlineAt: 1_000,
            status: "timed_out",
            timedOutAt: 999,
            createdAt: 0,
            updatedAt: 1_000,
        });
        await expect(feature.get(root, agent, "malformed-timeout")).rejects.toThrow(
            "precedes its deadline",
        );
    });

    it("includes terminal outcome details needed for follow-up work", async () => {
        const answeredStore = new UserInputTestStore();
        const answeredFeature = makeFeature(answeredStore);
        const answeredRequest = await createPending(answeredFeature);
        await answeredFeature.answer(root, agent, {
            operationId: "detail-answer",
            requestId: answeredRequest.id,
            answer: "The final answer.",
        });
        const answeredPage = await answeredFeature.getPage(root, agent, answeredRequest.id);
        expect(answeredPage.detail).toContain("Answer: The final answer.");

        const cancelledStore = new UserInputTestStore();
        const cancelledFeature = makeFeature(cancelledStore);
        const cancelledRequest = await createPending(cancelledFeature);
        await cancelledFeature.cancel(root, agent, {
            operationId: "detail-cancel",
            requestId: cancelledRequest.id,
            reason: "The decision is no longer needed.",
        });
        const cancelledPage = await cancelledFeature.getPage(root, agent, cancelledRequest.id);
        expect(cancelledPage.detail).toContain(
            "Cancellation reason: The decision is no longer needed.",
        );

        const timeoutStore = new UserInputTestStore();
        const timeoutFeature = makeFeature(timeoutStore);
        const timeoutRequest = await timeoutFeature.ask(root, agent, {
            operationId: "detail-timeout-ask",
            question: "Wait for the deadline?",
            context: "This timeout is deliberate.",
            deadlineAt: 1_000,
        });
        await timeoutFeature.complete(root, agent, {
            operationId: "detail-timeout",
            requestId: timeoutRequest.id,
            outcome: "timed_out",
            deadlineAt: 1_000,
        });
        const timeoutPage = await timeoutFeature.getPage(root, agent, timeoutRequest.id);
        expect(timeoutPage.detail).toContain("Timeout deadline: 1000");
    });

    it("publishes identical frozen transactional/post-commit events and contains listener failures", async () => {
        const store = new UserInputTestStore();
        const events: UserInputEvent[] = [];
        const postEvents: UserInputEvent[] = [];
        const feature = makeFeature(store, { events, postEvents });
        const request = await createPending(feature);
        expect(events).toHaveLength(1);
        expect(postEvents).toHaveLength(1);
        expect(postEvents[0]).toEqual(events[0]);
        expect(Object.isFrozen(events[0])).toBe(true);
        expect(Object.isFrozen(events[0]?.request)).toBe(true);
        expect(postEvents[0]).toBe(events[0]);
        expect(request.status).toBe("pending");

        const failingStore = new UserInputTestStore();
        const failing = makeFeature(failingStore, { transactionalFailure: true });
        await expect(createPending(failing)).rejects.toThrow("transactional listener failure");
        expect(failingStore.requests.size).toBe(0);
        expect(failingStore.postCommit).toHaveLength(0);

        const postFailureStore = new UserInputTestStore();
        const postErrors: unknown[] = [];
        const postFailure = new UserInputFeature({
            store: postFailureStore,
            idFactory: () => "post-failure-id",
            eventIdFactory: () => "post-failure-event",
            clock: () => 1_000,
            listener: {
                onEvent: async () => {
                    throw new Error("post failure");
                },
            },
            onPostCommitError: async (_ctx, _event, error) => {
                postErrors.push(error);
            },
        });
        await postFailure.ask(root, agent, {
            operationId: "post-failure-op",
            question: "Question",
            context: "Context",
        });
        expect(postErrors).toHaveLength(1);
    });

    it("runs post-commit callbacks outside the transaction queue", async () => {
        const store = new UserInputTestStore();
        let feature: UserInputFeature;
        let nested: Promise<UserInputRequest> | undefined;
        feature = new UserInputFeature({
            store,
            idFactory: () => "post-commit-request",
            eventIdFactory: () => "post-commit-event",
            clock: () => 1_000,
            listener: {
                onEvent: async (_ctx, event) => {
                    if (event.type !== "user_input_requested" || nested !== undefined) return;
                    nested = feature.cancel(root, agent, {
                        operationId: "post-commit-cancel",
                        requestId: event.requestId,
                        reason: "Cancel from post-commit work.",
                    });
                    await nested;
                },
            },
        });

        const request = await feature.ask(root, agent, {
            operationId: "post-commit-ask",
            question: "Can a callback mutate?",
            context: "The callback must not deadlock behind its own transaction.",
        });
        expect(request.status).toBe("pending");
        expect(nested).toBeDefined();
        await expect(nested!).resolves.toMatchObject({
            id: request.id,
            status: "cancelled",
        });
    });

    it("observes a rejected malformed after-commit registration", async () => {
        const store = new UserInputTestStore();
        vi.spyOn(store, "afterCommit").mockImplementation(
            () => Promise.reject(new Error("registration failed")) as unknown as void,
        );
        const feature = makeFeature(store);
        await expect(
            feature.ask(root, agent, {
                operationId: "rejected-after-commit",
                question: "Should this roll back?",
                context: "The malformed registration must be observed.",
            }),
        ).rejects.toThrow("afterCommit registration failed");
        expect(store.requests.size).toBe(0);
        expect(store.receipts.size).toBe(0);
        expect(store.proofs.size).toBe(0);
    });

    it("rejects a conflicting immutable proof instead of rewriting historical evidence", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        await createPending(feature);
        const key = `${agent}:ask-op`;
        const proof = store.proofs.get(key);
        expect(proof).toBeDefined();
        const conflicting = {
            ...proof!,
            before: proof!.after,
            changed: false,
        };
        await expect(store.writeMutationProof(root, conflicting, "if_absent")).rejects.toThrow(
            "immutable proof",
        );
        expect(store.proofs.get(key)).toEqual(proof);
    });

    it("keeps nested feature work and post-commit events inside an outer rollback", async () => {
        const store = new UserInputTestStore();
        const postEvents: UserInputEvent[] = [];
        const feature = makeFeature(store, { postEvents });
        await expect(
            store.transaction(root, agent, async (txCtx) => {
                await feature.ask(txCtx, agent, {
                    operationId: "outer-rollback-ask",
                    question: "Rollback?",
                    context: "This transaction must not commit.",
                });
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");
        expect(store.requests.size).toBe(0);
        expect(store.receipts.size).toBe(0);
        expect(store.proofs.size).toBe(0);
        expect(postEvents).toHaveLength(0);
    });

    it("does not resolve a durable waiter until a terminal write commits", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        const request = await createPending(feature);
        const hostWait = store.wait(root, agent, request.id);
        await vi.waitFor(() => expect(store.calls).toContain("wait"));
        await expect(
            store.transaction(root, agent, async (txCtx) => {
                await feature.complete(txCtx, agent, {
                    operationId: "rolled-back-completion",
                    requestId: request.id,
                    outcome: "away",
                });
                throw new Error("rollback terminal write");
            }),
        ).rejects.toThrow("rollback terminal write");
        expect(await Promise.race([hostWait.then(() => "resolved"), Promise.resolve("pending")])).toBe(
            "pending",
        );
        store.settle({
            ...request,
            status: "away",
            completedAt: 1_010,
            updatedAt: 1_010,
        });
        await expect(hostWait).resolves.toMatchObject({ status: "away" });
    });

    it("enforces store page bounds and keeps minimum-budget model pages actionable", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store, { maxOutputCharacters: 256 });
        const maximumId = "x".repeat(128);
        const request: UserInputRequest = {
            id: maximumId,
            askingAgentId: agent,
            question: "A question",
            context: "A bounded context document.",
            status: "pending",
            createdAt: 1_000,
            updatedAt: 1_000,
        };
        store.requests.set(maximumId, request);
        const detailPage = await feature.getPage(root, agent, maximumId);
        expect(detailPage.detail.length).toBeLessThanOrEqual(100);
        const detailOutput = feature.formatDetailPageForModel(detailPage);
        expect(detailOutput.length).toBeLessThanOrEqual(256);
        expect(detailOutput).toContain(maximumId);
        expect(detailOutput).toContain("Outcome: Pending.");
        expect(feature.formatForModel(request)).toContain(maximumId);
        expect(feature.formatPageForModel({ requests: [], cursor: "0", limit: 1 })).toContain(
            "Outcome:",
        );
        const formattedOversizedPage = feature.formatPageForModel({
            requests: [request, { ...request, id: "y".repeat(128) }],
            cursor: "0",
            limit: 2,
        });
        expect(formattedOversizedPage.length).toBeLessThanOrEqual(256);
        expect(formattedOversizedPage).toContain(maximumId);
        expect(formattedOversizedPage).toContain("More requests at cursor 1.");

        const oversizedPage = {
            requests: [request, { ...request, id: "second-request" }],
            cursor: "0",
            limit: 1,
        };
        vi.spyOn(store, "listRequests").mockResolvedValue(oversizedPage);
        await expect(feature.listPage(root, agent, { limit: 1 })).rejects.toThrow(
            "exceeded the requested page limit",
        );
    });

    it("requires the store to return the requested absolute page cursor", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        vi.spyOn(store, "listRequests").mockResolvedValue({
            requests: [],
            cursor: "50",
            limit: 1,
        });
        await expect(feature.listPage(root, agent, { cursor: "150", limit: 1 })).rejects.toThrow(
            "different source cursor",
        );
    });

    it("keeps earlier requests reachable with previous page cursors", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        await feature.ask(root, agent, {
            operationId: "page-one",
            question: "First request",
            context: "Page one.",
        });
        await feature.ask(root, agent, {
            operationId: "page-two",
            question: "Second request",
            context: "Page two.",
        });
        await feature.ask(root, agent, {
            operationId: "page-three",
            question: "Third request",
            context: "Page three.",
        });

        const middle = await feature.listPage(root, agent, { cursor: "1", limit: 1 });
        expect(middle.previousCursor).toBe("0");
        expect(middle.nextCursor).toBe("2");
        const end = await feature.listPage(root, agent, { cursor: "3", limit: 1 });
        expect(end.requests).toEqual([]);
        expect(end.previousCursor).toBe("2");
        expect(end.nextCursor).toBeUndefined();
    });

    it("serializes answer and cancel so exactly one terminal outcome wins", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);
        const request = await createPending(feature);
        const [answer, cancel] = await Promise.all([
            feature.answer(root, agent, {
                operationId: "race-answer",
                requestId: request.id,
                answer: "yes",
            }),
            feature.cancel(root, agent, {
                operationId: "race-cancel",
                requestId: request.id,
                reason: "closed",
            }),
        ]);
        expect(["answered", "cancelled"]).toContain(answer.status);
        expect(cancel.status).toBe(answer.status);
        expect((await feature.get(root, agent, request.id))?.status).toBe(answer.status);
        const replay = await feature.answer(root, agent, {
            operationId: "race-answer",
            requestId: request.id,
            answer: "yes",
        });
        expect(replay.status).toBe(answer.status);
    });

    it("replays cancellation and completion receipts after an intervening opposite transition", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store);

        const cancelledRequest = await createPending(feature);
        const cancelled = await feature.cancel(root, agent, {
            operationId: "cancel-replay",
            requestId: cancelledRequest.id,
            reason: "closed",
        });
        expect((await feature.get(root, agent, cancelledRequest.id))?.status).toBe("cancelled");
        await feature.answer(root, agent, {
            operationId: "answer-after-cancel",
            requestId: cancelledRequest.id,
            answer: "late",
        });
        expect((await feature.get(root, agent, cancelledRequest.id))?.status).toBe("cancelled");
        await expect(
            feature.cancel(root, agent, {
                operationId: "cancel-replay",
                requestId: cancelledRequest.id,
                reason: "closed",
            }),
        ).resolves.toEqual(cancelled);

        const completedRequest = await feature.ask(root, agent, {
            operationId: "complete-request",
            question: "Leave?",
            context: "The host is going away.",
        });
        const completed = await feature.complete(root, agent, {
            operationId: "complete-replay",
            requestId: completedRequest.id,
            outcome: "away",
        });
        await feature.cancel(root, agent, {
            operationId: "cancel-after-complete",
            requestId: completedRequest.id,
            reason: "late close",
        });
        await expect(
            feature.complete(root, agent, {
                operationId: "complete-replay",
                requestId: completedRequest.id,
                outcome: "away",
            }),
        ).resolves.toEqual(completed);
    });

    it("enforces options, bounds, paging, detail cursors, model output, and authorization", async () => {
        const store = new UserInputTestStore();
        const feature = makeFeature(store, {
            maxContextCharacters: 5,
            maxOutputCharacters: 256,
        });
        await expect(
            feature.ask(root, agent, {
                operationId: "too-large",
                question: "Question",
                context: "too long",
            }),
        ).rejects.toThrow("configured bound");
        const request = await feature.ask(root, agent, {
            operationId: "options",
            question: "Choose",
            context: "short",
            options: {
                multiSelect: false,
                choices: [
                    { label: "yes", description: "Proceed." },
                    { label: "no", description: "Stop." },
                ],
            },
        });
        await expect(
            feature.answer(root, agent, {
                operationId: "bad-answer",
                requestId: request.id,
                answer: { selectedOptions: ["missing"] },
            }),
        ).rejects.toThrow("undeclared option");
        const answered = await feature.answer(root, agent, {
            operationId: "good-answer",
            requestId: request.id,
            answer: { selectedOptions: ["yes"] },
        });
        expect(answered.status).toBe("answered");
        const page = await feature.listPage(root, agent, { limit: 1 });
        expect(page.requests).toHaveLength(1);
        const detail = await feature.getPage(root, agent, request.id, {
            limit: 3,
        });
        expect(detail.nextCursor).toBeDefined();
        expect(feature.formatDetailPageForModel(detail)).toContain(request.id);
        expect(formatUserInputForModel({ ...answered, id: "x".repeat(128) }, 256)).toContain(
            "x".repeat(128),
        );
        await expect(feature.get(root, otherAgent, request.id)).rejects.toThrow("not authorized");

        const authorized = makeFeature(store, { authorize: true });
        await expect(authorized.get(root, otherAgent, request.id)).resolves.toEqual(answered);
    });
});