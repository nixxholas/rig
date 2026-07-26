import { describe, expect, it } from "vitest";

import {
    defineModel,
    defineProvider,
    type Context,
    type Model,
    type StreamOptions,
} from "@slopus/rig-execution";
import { Agent } from "../agent/Agent.js";
import type { Message } from "../agent/types.js";
import { createJustBashToolHarness } from "../tools/testing/createJustBashToolHarness.js";
import { createPermissionContext } from "./createPermissionContext.js";
import { createPermissionReviewSideAgent } from "./createPermissionReviewSideAgent.js";

describe("createPermissionReviewSideAgent", () => {
    it("runs a dedicated reviewer model without exposing it as a selectable model", async () => {
        const recorded = recordingProvider();
        const reviewerModel = defineModel({
            id: "openai/codex-auto-review",
            name: "Codex Auto Review",
            thinkingLevels: ["low"],
            defaultThinkingLevel: "low",
        });
        const requestedModels: string[] = [];
        const provider = {
            ...recorded.provider,
            reviewerModel,
            stream<TThinkingLevel extends string>(
                model: Model<TThinkingLevel>,
                context: Context,
                options?: StreamOptions<TThinkingLevel>,
            ) {
                requestedModels.push(model.id);
                return recorded.provider.stream(model, context, options);
            },
        };

        expect(provider.models.map((model) => model.id)).not.toContain(reviewerModel.id);
        expect(
            () =>
                new Agent({
                    context: createJustBashToolHarness().context,
                    modelId: reviewerModel.id,
                    provider,
                    tools: [],
                }),
        ).toThrow(`Unknown model '${reviewerModel.id}'`);
        const reviewer = sideAgent(provider, reviewerModel as never);
        await reviewer.review({ action: "review this", messages: [user("u1", "AUTHORIZED")] });

        expect(requestedModels).toEqual([reviewerModel.id]);
        await reviewer.close();
    });

    it("sends only new conversation once it already has its own history", async () => {
        const { provider, model, requests } = recordingProvider();
        const reviewer = sideAgent(provider, model);

        await reviewer.review({ action: "first action", messages: [user("u1", "ALPHA")] });
        await reviewer.review({
            action: "second action",
            messages: [user("u1", "ALPHA"), user("u2", "BRAVO")],
        });

        const second = JSON.stringify(requests[1]?.messages.at(-1)?.content ?? "");
        expect(second).toContain("BRAVO");
        // ALPHA is already in the reviewer's own history; repeating it would nest every earlier
        // review's context inside the next one.
        expect(second).not.toContain("ALPHA");
        expect(second).toContain("second action");
        await reviewer.close();
    });

    it("forgets pre-reset authorization and sends a new prohibition as fresh evidence", async () => {
        const { provider, model, requests } = recordingProvider();
        const reviewer = sideAgent(provider, model);

        await reviewer.review({ action: "first action", messages: [user("u1", "AUTHORIZED")] });
        await reviewer.reset();
        const result = await reviewer.review({
            action: "second action",
            messages: [user("u2", "PROHIBITED")],
        });

        expect(JSON.stringify(requests[1]?.messages)).toContain("PROHIBITED");
        expect(JSON.parse(result.text)).toMatchObject({ decision: "deny" });
        await reviewer.close();
    });

    it("starts over when a review is cut short, so it never stacks two unanswered questions", async () => {
        const { provider, model, requests } = recordingProvider({ cutShortOnCall: 1 });
        const reviewer = sideAgent(provider, model);

        await reviewer
            .review({ action: "first action", messages: [user("u1", "ALPHA")] })
            .catch(() => undefined);

        await reviewer.review({
            action: "second action",
            messages: [user("u1", "ALPHA"), user("u2", "BRAVO")],
        });

        const second = requests[1]?.messages ?? [];
        expect(second.filter((message) => message.role === "user")).toHaveLength(1);
        // Starting over means the reviewer has no history, so it needs the conversation again.
        expect(JSON.stringify(second.at(-1)?.content)).toContain("ALPHA");
        await reviewer.close();
    });

    it("refuses to review while it is itself in Auto mode", () => {
        const { provider, model } = recordingProvider();
        const harness = createJustBashToolHarness();
        harness.context.permissions = createPermissionContext("auto");

        expect(() =>
            createPermissionReviewSideAgent({
                context: harness.context,
                id: "auto-reviewer",
                model,
                provider,
                tools: [],
            }),
        ).toThrow("must not run in Auto mode");
    });

    it("reports omitted user evidence from the whole conversation, not just the delta", async () => {
        const { provider, model } = recordingProvider();
        const reviewer = sideAgent(provider, model);
        const oversized = Array.from({ length: 7 }, (_, index) =>
            user(`u${String(index)}`, `EVIDENCE_${String(index)} ${"e".repeat(10_000)}`),
        );

        await reviewer.review({ action: "first", messages: oversized });
        const second = await reviewer.review({
            action: "second",
            messages: [...oversized, user("late", "one more")],
        });

        expect(second.userEvidenceOmitted).toBe(true);
        await reviewer.close();
    });
});

function sideAgent(provider: ReturnType<typeof recordingProvider>["provider"], model: never) {
    const harness = createJustBashToolHarness();
    harness.context.permissions = createPermissionContext("read_only");
    return createPermissionReviewSideAgent({
        context: harness.context,
        id: "auto-reviewer",
        model,
        provider,
        tools: [],
    });
}

function user(id: string, text: string): Message {
    return { role: "user", id, blocks: [{ type: "text", text }] };
}

function recordingProvider(options: { cutShortOnCall?: number } = {}) {
    const model = defineModel({
        id: "openai/gpt-test",
        name: "GPT Test",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const requests: Context[] = [];
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream(_model, context) {
            requests.push(context);
            const call = requests.length;
            const denied = JSON.stringify(context.messages).includes("PROHIBITED");
            const message = {
                api: "test",
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            decision: denied ? "deny" : "allow",
                            risk: denied ? "high" : "low",
                            user_authorization: denied ? "low" : "high",
                            reason: denied ? "The user prohibited this action." : "Routine.",
                        }),
                    },
                ],
                model: model.id,
                provider: "codex",
                role: "assistant" as const,
                stopReason: (call === options.cutShortOnCall ? "aborted" : "stop") as
                    | "aborted"
                    | "stop",
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
            return {
                async *[Symbol.asyncIterator]() {
                    if (call === options.cutShortOnCall) {
                        yield {
                            error: message,
                            reason: "aborted" as const,
                            type: "error" as const,
                        };
                        return;
                    }
                    yield { message, reason: "stop" as const, type: "done" as const };
                },
                async result() {
                    return message;
                },
            };
        },
    });
    return { model: model as never, provider, requests };
}
