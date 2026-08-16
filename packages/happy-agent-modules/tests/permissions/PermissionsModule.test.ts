import {
    Agent,
    AgentSystemLocal,
    agentPermissionMode,
    defineAgentTool,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MAX_PERMISSION_ACTION,
    PermissionsModule,
    mergePermissionToolGuidances,
    permissionModeChangeNotice,
    type PermissionEvent,
    type PermissionReviewDecision,
    type PermissionReviewRequest,
    type PermissionReviewer,
} from "../../sources/permissions/index.js";
import { PermissionRefusalCircuitBreaker } from "../../sources/permissions/impl/permissionRefusalCircuitBreaker.js";
import { permissionModeGuidance } from "../../sources/permissions/impl/permissionModeGuidance.js";
import { permissionTurnStoppedReason } from "../../sources/permissions/impl/permissionRefusalMessage.js";
import { agentWorld } from "../support/agentWorld.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../support/fixtures.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-modules-permissions");

/** What each tool execution was actually allowed to run under. */
const ran: { tool: string; mode: AgentPermissionMode }[] = [];

/** An ordinary tool: nothing about it needs deciding. */
const routineTool = defineAgentTool({
    name: "look",
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => false,
    execute: (toolCtx: Context) => {
        ran.push({ tool: "look", mode: agentPermissionMode(toolCtx) });
        return Promise.resolve({});
    },
    toLLM: () => [{ type: "text", text: "looked" }],
});

/** A tool that asks for a review, and says this invocation must leave the sandbox to run. */
const escalatingTool = defineAgentTool({
    name: "publish",
    parameters: Type.Object({ target: Type.String() }, { additionalProperties: false }),
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ target }) => `Publish to ${target}, outside the workspace.`,
    execute: (toolCtx: Context) => {
        ran.push({ tool: "publish", mode: agentPermissionMode(toolCtx) });
        return Promise.resolve({});
    },
    toLLM: () => [{ type: "text", text: "published" }],
});

/** A tool Rig's own sandbox cannot contain at all. */
const externalTool = defineAgentTool({
    name: "call_server",
    returnType: Type.Object({}),
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: () => "Call a server that acts outside this machine.",
    execute: (toolCtx: Context) => {
        ran.push({ tool: "call_server", mode: agentPermissionMode(toolCtx) });
        return Promise.resolve({});
    },
    toLLM: () => [{ type: "text", text: "called" }],
});

/** A reviewable tool with the action describer accidentally omitted. */
const missingDescriptionTool = defineAgentTool({
    name: "missing_description",
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => true,
    execute: (toolCtx: Context) => {
        ran.push({ tool: "missing_description", mode: agentPermissionMode(toolCtx) });
        return Promise.resolve({});
    },
    toLLM: () => [{ type: "text", text: "ran despite the definition error" }],
});

/** A reviewable tool whose action boundary is deliberately beyond the request limit. */
const oversizedActionTool = defineAgentTool({
    name: "oversized_action",
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: () => "x".repeat(MAX_PERMISSION_ACTION + 1),
    execute: (toolCtx: Context) => {
        ran.push({ tool: "oversized_action", mode: agentPermissionMode(toolCtx) });
        return Promise.resolve({});
    },
    toLLM: () => [{ type: "text", text: "oversized action ran" }],
});

/** A reviewable tool with unconstrained provider arguments; permissions applies its own bound. */
const oversizedArgumentsTool = defineAgentTool({
    name: "oversized_arguments",
    parameters: Type.Any(),
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: () => "Inspect the supplied arguments.",
    execute: (toolCtx: Context) => {
        ran.push({ tool: "oversized_arguments", mode: agentPermissionMode(toolCtx) });
        return Promise.resolve({});
    },
    toLLM: () => [{ type: "text", text: "oversized arguments ran" }],
});

function reviewerAnswering(
    decide: (request: PermissionReviewRequest) => PermissionReviewDecision,
): PermissionReviewer & { readonly seen: PermissionReviewRequest[] } {
    const seen: PermissionReviewRequest[] = [];
    return {
        seen,
        review: (_reviewCtx, request) => {
            seen.push(request);
            return Promise.resolve(decide(request));
        },
    };
}

/** One agent running the permissions module over its own isolated store. */
async function permissionAgent(
    agentId: string,
    script: SessionEvent[][],
    options: {
        readonly reviewer?: PermissionReviewer;
        readonly events?: PermissionEvent[];
        readonly permissionMode?: AgentPermissionMode;
        readonly refusalsBeforeStopping?: number;
        readonly reviewTimeoutMs?: number;
        readonly toolGuidance?: readonly { readonly autoPermissionInstructions?: string }[];
        readonly killAllSessions?: (ctx: Context, agentId: string) => Promise<void> | void;
    } = {},
) {
    const world = await agentWorld();
    const provider = new ScriptedProvider(script);
    const permissions = new PermissionsModule({
        ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
        ...(options.refusalsBeforeStopping === undefined
            ? {}
            : { refusalsBeforeStopping: options.refusalsBeforeStopping }),
        ...(options.reviewTimeoutMs === undefined
            ? {}
            : { reviewTimeoutMs: options.reviewTimeoutMs }),
        ...(options.toolGuidance === undefined ? {} : { toolGuidance: options.toolGuidance }),
        killAllSessions: options.killAllSessions ?? (() => {}),
        ...(options.events === undefined
            ? {}
            : {
                  listener: {
                      onEvent: (_eventCtx, event) => {
                          options.events?.push(event);
                      },
                  },
              }),
    });
    const agent = await Agent.create(ctx, {
        id: agentId,
        providers: providersOf(provider),
        provider: "scripted",
        persistence: world.storage.persistence(agentId),
        sharedKV: sharedKV(),
        modules: [permissions],
        initialState: {
            tools: [
                routineTool,
                escalatingTool,
                externalTool,
                missingDescriptionTool,
                oversizedActionTool,
                oversizedArgumentsTool,
            ],
        },
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    });
    return { agent, permissions, provider, world };
}

/** Every tool result the agent sent back to the model, as text. */
function toolResults(provider: ScriptedProvider): string[] {
    return (provider.sessions[0]?.requests ?? []).flatMap((request) =>
        request.context.messages.flatMap((message) =>
            message.role === "tool"
                ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                : [],
        ),
    );
}

function wideArguments(count: number): string {
    return JSON.stringify(
        Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, index])),
    );
}

describe("PermissionsModule", () => {
    it("runs a reviewed action under Full access, and only for that call", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "low",
            userAuthorization: "high",
        }));
        const events: PermissionEvent[] = [];
        const { agent, provider } = await permissionAgent(
            "elevating-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                toolCallTurn("call-2", "look", "{}"),
                textTurn("done"),
            ],
            { reviewer, events },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([
            { tool: "publish", mode: "full_access" },
            { tool: "look", mode: "auto" },
        ]);
        expect(reviewer.seen).toHaveLength(1);
        expect(reviewer.seen[0]?.action).toBe("Publish to /etc/hosts, outside the workspace.");
        expect(reviewer.seen[0]?.elevates).toBe(true);
        expect(events).toEqual([
            {
                type: "permission_action_reviewed",
                agentId: "elevating-agent",
                callId: "call-1",
                tool: "publish",
                action: "Publish to /etc/hosts, outside the workspace.",
                elevated: true,
                reason: "The reviewer allowed this action.",
                risk: "low",
                userAuthorization: "high",
            },
        ]);
        expect(toolResults(provider).join("\n")).toContain("published");
    });

    it("turns a denial into a final refusal the model is told not to route around", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "The file belongs to the system, and nothing the user said covers it.",
            risk: "high",
            userAuthorization: "low",
        }));
        const { agent, provider } = await permissionAgent(
            "denied-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                textTurn("understood"),
            ],
            { reviewer, events },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        const results = toolResults(provider).join("\n");
        expect(results).toContain("reviewed and refused");
        expect(results).toContain("The file belongs to the system");
        expect(results).toContain("materially safer alternative");
        expect(events[0]).toMatchObject({ type: "permission_action_denied", callId: "call-1" });
    });

    it("does not honor an allowed critical-risk review", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "critical",
            userAuthorization: "high",
        }));
        const { agent, provider } = await permissionAgent(
            "critical-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                textTurn("stop"),
            ],
            { reviewer, events },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        expect(toolResults(provider).join("\n")).toContain("independent Auto policy");
        expect(events[0]).toMatchObject({ type: "permission_action_denied" });
    });

    it("refuses a high-risk allow without medium user authorization", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "high",
            userAuthorization: "low",
        }));
        const { agent, provider } = await permissionAgent(
            "high-risk-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                textTurn("stop"),
            ],
            { reviewer },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        expect(toolResults(provider).join("\n")).toContain(
            "requires at least medium user authorization",
        );
    });

    it("refuses an action nobody reviewed as unproven rather than as unsafe", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const { agent, provider } = await permissionAgent(
            "unreviewed-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                textTurn("stopping"),
            ],
            { events },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        const results = toolResults(provider).join("\n");
        expect(results).toContain("could not be reviewed");
        expect(results).toContain("it is unproven");
        expect(results).not.toContain("reviewed and refused");
        expect(events[0]).toMatchObject({ type: "permission_action_unproven" });
    });

    it("refuses a reviewable tool whose action description is missing", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "low",
            userAuthorization: "high",
        }));
        const { agent, provider } = await permissionAgent(
            "missing-description-agent",
            [toolCallTurn("call-1", "missing_description", "{}"), textTurn("stop")],
            { reviewer },
        );

        await agent.send(ctx, user("run it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        expect(reviewer.seen).toEqual([]);
        expect(toolResults(provider).join("\n")).toContain(
            "cannot request Auto approval because its permission action is not defined",
        );
    });

    it("bounds the action description before asking the reviewer", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "low",
            userAuthorization: "high",
        }));
        const { agent, provider } = await permissionAgent(
            "oversized-action-agent",
            [toolCallTurn("call-1", "oversized_action", "{}"), textTurn("stop")],
            { reviewer },
        );

        await agent.send(ctx, user("run it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        expect(reviewer.seen).toEqual([]);
        expect(toolResults(provider).join("\n")).toContain("permission request is invalid");
    });

    it("bounds and detaches arguments before asking the reviewer", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "low",
            userAuthorization: "high",
        }));
        const { agent, provider } = await permissionAgent(
            "oversized-arguments-agent",
            [toolCallTurn("call-1", "oversized_arguments", wideArguments(257)), textTurn("stop")],
            { reviewer },
        );

        await agent.send(ctx, user("inspect it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([]);
        expect(reviewer.seen).toEqual([]);
        expect(toolResults(provider).join("\n")).toContain("permission request is invalid");
    });

    it("gives the reviewer a frozen argument snapshot", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering((_request) => ({
            outcome: "allowed",
            risk: "low",
            userAuthorization: "high",
        }));
        const seen = reviewer.seen;
        reviewer.review = (_reviewCtx, request) => {
            seen.push(request);
            expect(Object.isFrozen(request.arguments)).toBe(true);
            return Promise.resolve({
                outcome: "allowed",
                risk: "low",
                userAuthorization: "high",
            });
        };
        const { agent } = await permissionAgent(
            "frozen-arguments-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/tmp/output" })),
                textTurn("done"),
            ],
            { reviewer },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(ran).toEqual([{ tool: "publish", mode: "full_access" }]);
        expect(seen).toHaveLength(1);
    });

    it("distinguishes an unavailable reviewer from a timeout", async () => {
        const unavailable = reviewerAnswering(() => {
            throw new Error("reviewer offline");
        });
        const unavailableRun = await permissionAgent(
            "unavailable-reviewer-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                textTurn("stop"),
            ],
            { reviewer: unavailable },
        );
        await unavailableRun.agent.send(ctx, user("publish it"), { await: true });
        await unavailableRun.agent.waitForIdle();
        expect(toolResults(unavailableRun.provider).join("\n")).toContain(
            "Continue with work that does not need this permission",
        );
        await unavailableRun.agent.close();

        let timedOutSignal: AbortSignal | undefined;
        const timeoutReviewer: PermissionReviewer = {
            review: (_reviewCtx, request) =>
                new Promise<PermissionReviewDecision>((resolve) => {
                    timedOutSignal = request.signal;
                    request.signal.addEventListener("abort", () =>
                        resolve({
                            outcome: "denied",
                            reason: "The reviewer was cancelled.",
                        }),
                    );
                }),
        };
        const timedOut = await permissionAgent(
            "timeout-reviewer-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/etc/hosts" })),
                textTurn("stop"),
            ],
            { reviewer: timeoutReviewer, reviewTimeoutMs: 5 },
        );
        await timedOut.agent.send(ctx, user("publish it"), { await: true });
        await timedOut.agent.waitForIdle();
        expect(toolResults(timedOut.provider).join("\n")).toContain(
            "You may try once more, or ask the user how to proceed",
        );
        expect(timedOutSignal?.aborted).toBe(true);
        await timedOut.agent.close();
    });

    it("keeps a tool that leaves the sandbox out of the restricted modes, without a review", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            risk: "low",
            userAuthorization: "high",
        }));
        const { agent, provider } = await permissionAgent(
            "restricted-agent",
            [
                toolCallTurn("call-1", "call_server", "{}"),
                toolCallTurn("call-2", "look", "{}"),
                textTurn("done"),
            ],
            { reviewer, events, permissionMode: "read_only" },
        );

        await agent.send(ctx, user("go and look"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        // The routine tool still runs, under the mode the agent is in; nothing was reviewed.
        expect(ran).toEqual([{ tool: "look", mode: "read_only" }]);
        expect(reviewer.seen).toEqual([]);
        expect(toolResults(provider).join("\n")).toContain("unavailable in Read only mode");
        expect(events[0]).toMatchObject({
            type: "permission_action_out_of_mode",
            tool: "call_server",
            mode: "read_only",
        });
    });

    it("tells the model what the mode in force permits", async () => {
        const { agent, provider } = await permissionAgent(
            "instructed-agent",
            [textTurn("understood")],
            { permissionMode: "workspace_write" },
        );

        await agent.send(ctx, user("hello"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const instructions = provider.sessions[0]?.options.instructions ?? "";
        expect(instructions).toContain("Workspace write mode");
        expect(instructions).toContain("asking to escalate has no effect");
    });

    it("includes sandbox limits and deduplicated Auto tool guidance", () => {
        const guidance = permissionModeGuidance("auto", [
            { autoPermissionInstructions: "Set escalate_sandbox to true when needed." },
            { autoPermissionInstructions: "Set escalate_sandbox to true when needed." },
            { autoPermissionInstructions: "Give a concise justification." },
        ]);

        expect(guidance).toContain("Shell commands run in a sandbox with these limits:");
        expect(guidance).toContain("Set escalate_sandbox to true when needed.");
        expect(guidance).toContain("Give a concise justification.");
        expect(guidance.match(/Set escalate_sandbox to true when needed\./gu)).toHaveLength(1);
    });

    it("bounds and deduplicates guidance across independently limited sources", () => {
        const staticGuidance = Array.from({ length: 129 }, (_, index) => ({
            autoPermissionInstructions: `static-${index}`,
        }));
        const providerGuidance = Array.from({ length: 128 }, (_, index) => ({
            autoPermissionInstructions: `provider-${index}`,
        }));

        const merged = mergePermissionToolGuidances([staticGuidance, providerGuidance]);

        expect(merged).toHaveLength(256);
        expect(new Set(merged.map((item) => item.autoPermissionInstructions)).size).toBe(256);
        expect(merged.at(-1)?.autoPermissionInstructions).toBe("provider-126");
    });

    it("stops a high refusal rate even when successes reset the consecutive streak", () => {
        const circuit = new PermissionRefusalCircuitBreaker(100);
        let stopped = false;
        for (let index = 0; index < 20 && !stopped; index += 1) {
            stopped = circuit.recordRefusal().newlyStopped;
            if (!stopped) circuit.recordAllowed();
        }

        expect(stopped).toBe(true);
    });

    it("stops a turn that keeps being refused", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
            risk: "high",
            userAuthorization: "low",
        }));
        const world = await agentWorld();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "publish" },
                {
                    type: "toolcall_end",
                    callId: "call-1",
                    arguments: JSON.stringify({ target: "a" }),
                },
                { type: "toolcall_start", callId: "call-2", name: "publish" },
                {
                    type: "toolcall_end",
                    callId: "call-2",
                    arguments: JSON.stringify({ target: "b" }),
                },
                { type: "toolcall_start", callId: "call-3", name: "look" },
                {
                    type: "toolcall_end",
                    callId: "call-3",
                    arguments: "{}",
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("never asked again"),
        ]);
        const permissions = new PermissionsModule({
            reviewer,
            refusalsBeforeStopping: 2,
            listener: {
                onEvent: (_eventCtx, event) => {
                    events.push(event);
                },
            },
            killAllSessions: () => {},
        });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
            modules: [permissions],
        });
        const agent = await system.create(ctx, {});
        agent.state.tools = [routineTool, escalatingTool, externalTool];

        await agent.send(ctx, user("publish everything"), { await: true });
        await agent.waitForIdle();

        expect(ran).toEqual([]);
        expect(events.some((event) => event.type === "permission_turn_stopped")).toBe(true);
        // The delayed routine call was gated even though the provider had already emitted it.
        expect(toolResults(provider).join("\n")).not.toContain("looked");
        await system.close(ctx);
    });

    it("enforces the mode a steered message made effective", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const killedFor: string[] = [];
        const world = await agentWorld();
        const provider = new ScriptedProvider([
            textTurn("noted"),
            toolCallTurn("call-1", "look", "{}"),
            textTurn("looked"),
        ]);
        const permissions = new PermissionsModule({
            listener: {
                onEvent: (_eventCtx, event) => {
                    events.push(event);
                },
            },
            killAllSessions: (_killCtx, agentId) => {
                killedFor.push(agentId);
            },
        });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
            modules: [permissions],
        });
        const agent = await system.create(ctx, {});
        agent.state.tools = [routineTool, escalatingTool, externalTool, missingDescriptionTool];

        // The mode is the agent's, so a host changes it the way anything else about a turn
        // changes: by steering a message that carries it.
        await agent.steer(
            ctx,
            {
                role: "user",
                content: [{ type: "text", text: permissionModeChangeNotice("read_only") }],
            },
            { permissionMode: "read_only" },
        );
        await agent.waitForIdle();

        expect(events).toContainEqual({
            type: "permission_mode_changed",
            agentId: agent.id,
            previousMode: "auto",
            mode: "read_only",
        });
        expect(killedFor).toEqual([agent.id]);
        const asked = (provider.sessions[0]?.requests ?? []).flatMap((request) =>
            request.context.messages.flatMap((message) =>
                message.role === "user"
                    ? message.content.flatMap((block) =>
                          block.type === "text" ? [block.text] : [],
                      )
                    : [],
            ),
        );
        expect(asked.join("\n")).toContain("changed to Read only");
        expect(provider.sessions[0]?.requests[0]?.context.instructions ?? "").toContain(
            "Read only mode",
        );

        // The new mode is what the next tool call runs under.
        await agent.send(ctx, user("have a look"), { await: true });
        await agent.waitForIdle();
        expect(ran).toEqual([{ tool: "look", mode: "read_only" }]);
        await system.close(ctx);
    });

    it("reports a failed elevated-session cleanup after a mode reduction", async () => {
        const events: PermissionEvent[] = [];
        const run = await permissionAgent("cleanup-failure-agent", [textTurn("noted")], {
            events,
            killAllSessions: () => {
                throw new Error("shell cleanup unavailable");
            },
        });

        await run.agent.steer(
            ctx,
            {
                role: "user",
                content: [{ type: "text", text: permissionModeChangeNotice("read_only") }],
            },
            { permissionMode: "read_only" },
        );
        await run.agent.waitForIdle();
        await run.agent.close();

        expect(events).toContainEqual({
            type: "permission_mode_cleanup_failed",
            agentId: "cleanup-failure-agent",
            previousMode: "auto",
            mode: "read_only",
            reason: "shell cleanup unavailable",
        });
        expect(events).toContainEqual({
            type: "permission_mode_changed",
            agentId: "cleanup-failure-agent",
            previousMode: "auto",
            mode: "read_only",
        });
    });

    it("carries the reviewer's risk, authorization, and transcript into the reviewed event", async () => {
        ran.length = 0;
        const transcript = {
            entries: [
                { type: "text" as const, text: "The target is inside the workspace." },
                { type: "tool_call" as const, name: "read", arguments: '{"path":"a"}' },
                { type: "tool_result" as const, name: "read", isError: false, text: "ok" },
            ],
            modelId: "codex-auto-review",
            providerId: "codex",
            usage: { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19 },
        };
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "allowed",
            reason: "The user asked for exactly this.",
            risk: "medium",
            userAuthorization: "high",
            transcript,
        }));
        const { agent } = await permissionAgent(
            "review-metadata-agent",
            [
                toolCallTurn("call-1", "publish", JSON.stringify({ target: "/tmp/out" })),
                textTurn("done"),
            ],
            { reviewer, events },
        );

        await agent.send(ctx, user("publish it"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(events).toEqual([
            {
                type: "permission_action_reviewed",
                agentId: "review-metadata-agent",
                callId: "call-1",
                tool: "publish",
                action: "Publish to /tmp/out, outside the workspace.",
                elevated: true,
                reason: "The user asked for exactly this.",
                risk: "medium",
                userAuthorization: "high",
                transcript,
            },
        ]);
    });

    it("emits exact refusal counts and the full breaker reason before the abort", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
            risk: "high",
            userAuthorization: "low",
        }));
        const { agent } = await permissionAgent(
            "threshold-three-agent",
            [
                [
                    { type: "toolcall_start", callId: "call-1", name: "publish" },
                    {
                        type: "toolcall_end",
                        callId: "call-1",
                        arguments: JSON.stringify({ target: "a" }),
                    },
                    { type: "toolcall_start", callId: "call-2", name: "publish" },
                    {
                        type: "toolcall_end",
                        callId: "call-2",
                        arguments: JSON.stringify({ target: "b" }),
                    },
                    { type: "toolcall_start", callId: "call-3", name: "publish" },
                    {
                        type: "toolcall_end",
                        callId: "call-3",
                        arguments: JSON.stringify({ target: "c" }),
                    },
                    { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
                ],
                textTurn("never asked again"),
            ],
            { reviewer, events },
        );

        await agent.send(ctx, user("publish everything"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const stopped = events.filter((event) => event.type === "permission_turn_stopped");
        expect(stopped).toEqual([
            {
                type: "permission_turn_stopped",
                agentId: "threshold-three-agent",
                consecutiveRefusals: 3,
                recentRefusals: 3,
                recentWindowLength: 3,
                reason: permissionTurnStoppedReason(3, 3, 3),
            },
        ]);
        expect(stopped[0]?.reason).toContain(
            "Automatic permission review refused too many actions in this turn " +
                "(3 in a row, 3 of the last 3), so the turn was stopped.",
        );
        expect(stopped[0]?.reason).toContain(
            "Tell the user what you were trying to do and why it kept being refused.",
        );
    });

    it("trips on the refusal rate with the exact window even when successes reset the streak", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
            risk: "high",
            userAuthorization: "low",
        }));
        const turn: SessionEvent[] = [];
        for (let index = 1; index <= 10; index += 1) {
            turn.push(
                { type: "toolcall_start", callId: `p${index}`, name: "publish" },
                {
                    type: "toolcall_end",
                    callId: `p${index}`,
                    arguments: JSON.stringify({ target: `t${index}` }),
                },
            );
            // A successful call between refusals clears the streak but stays in the rate window.
            if (index < 10) {
                turn.push(
                    { type: "toolcall_start", callId: `l${index}`, name: "look" },
                    { type: "toolcall_end", callId: `l${index}`, arguments: "{}" },
                );
            }
        }
        turn.push({ type: "done", state: "tool_call", tokens: { input: 1, output: 1 } });

        const { agent } = await permissionAgent(
            "rate-window-agent",
            [turn, textTurn("never asked again")],
            { reviewer, events, refusalsBeforeStopping: 100 },
        );

        await agent.send(ctx, user("publish repeatedly"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const stopped = events.filter((event) => event.type === "permission_turn_stopped");
        expect(stopped).toEqual([
            {
                type: "permission_turn_stopped",
                agentId: "rate-window-agent",
                consecutiveRefusals: 1,
                recentRefusals: 10,
                recentWindowLength: 19,
                reason: permissionTurnStoppedReason(1, 10, 19),
            },
        ]);
    });

    it("records a turn-stop event before the abort it triggers settles the run", async () => {
        ran.length = 0;
        const order: string[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
            risk: "high",
            userAuthorization: "low",
        }));
        const world = await agentWorld();
        const provider = new ScriptedProvider([threeDeniedPublishTurn(), textTurn("done")]);
        const permissions = new PermissionsModule({
            reviewer,
            refusalsBeforeStopping: 3,
            listener: {
                onEvent: async (_eventCtx, event) => {
                    if (event.type === "permission_turn_stopped") {
                        // A real asynchronous gap. If the decision did not await the listener, the
                        // abort it triggers would settle the run before this line ran, and the
                        // settlement marker below would land first. A single flushed microtask would
                        // not expose that; this delay does.
                        await new Promise<void>((resolve) => setTimeout(resolve, 30));
                    }
                    order.push(`event:${event.type}`);
                },
            },
            killAllSessions: () => {},
        });
        // A second module records when the run settles, so the two orderings can be compared: the
        // turn-stop event must be durably observed before the settlement the abort produces.
        const settleObserver = {
            name: "settle-observer",
            afterAgentSettled: () => {
                order.push("settled");
            },
        };
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
            modules: [permissions, settleObserver],
        });
        const agent = await system.create(ctx, {});
        agent.state.tools = [routineTool, escalatingTool, externalTool];
        await agent.send(ctx, user("publish everything"), { await: true });
        await agent.waitForIdle();
        await system.close(ctx);

        const stoppedIndex = order.indexOf("event:permission_turn_stopped");
        const settledIndex = order.indexOf("settled");
        expect(stoppedIndex).toBeGreaterThanOrEqual(0);
        expect(settledIndex).toBeGreaterThanOrEqual(0);
        expect(stoppedIndex).toBeLessThan(settledIndex);
    });

    it("does not let a listener that never settles wedge the turn", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
            risk: "high",
            userAuthorization: "low",
        }));
        const world = await agentWorld();
        const provider = new ScriptedProvider([threeDeniedPublishTurn(), textTurn("done")]);
        const recorded: PermissionEvent[] = [];
        let hungCalls = 0;
        const permissions = new PermissionsModule({
            reviewer,
            refusalsBeforeStopping: 3,
            // A tiny bound so the test proves the ceiling exists without waiting the real budget on
            // it. Production uses seconds; the behavior under test is the same.
            announceTimeoutMs: 20,
            listener: {
                onEvent: (_eventCtx, event) => {
                    recorded.push(event);
                    if (event.type === "permission_turn_stopped") {
                        hungCalls += 1;
                        // Never settles. Without a bound this would leave the refusal path awaiting
                        // forever, so the abort that ends the runaway turn would never run and the
                        // agent would never reach idle — this test would hang instead of passing.
                        return new Promise<void>(() => {});
                    }
                    return undefined;
                },
            },
            killAllSessions: () => {},
        });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
            modules: [permissions],
        });
        const agent = await system.create(ctx, {});
        agent.state.tools = [routineTool, escalatingTool, externalTool];
        await agent.send(ctx, user("publish everything"), { await: true });
        // Reaching idle at all is the proof: a wedged observer no longer holds the decision, so the
        // abort ran and the run settled.
        await agent.waitForIdle();
        await system.close(ctx);

        expect(hungCalls).toBe(1);
        // The decisions still stand: all three actions were refused and the turn stopped, regardless
        // of the wedged observer.
        expect(recorded.filter((event) => event.type === "permission_action_denied")).toHaveLength(
            3,
        );
        expect(recorded.some((event) => event.type === "permission_turn_stopped")).toBe(true);
    });

    it("contains a listener that throws so the decisions still stand and the run settles", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
            risk: "high",
            userAuthorization: "low",
        }));
        const throwingWorld = await agentWorld();
        const throwingProvider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "publish" },
                {
                    type: "toolcall_end",
                    callId: "call-1",
                    arguments: JSON.stringify({ target: "a" }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("understood"),
        ]);
        const throwingPermissions = new PermissionsModule({
            reviewer,
            listener: {
                onEvent: () => {
                    throw new Error("listener exploded");
                },
            },
            killAllSessions: () => {},
        });
        const throwingSystem = await AgentSystemLocal.create(ctx, throwingWorld.storage, {
            providers: providersOf(throwingProvider),
            provider: "scripted",
            models: [],
            modules: [throwingPermissions],
        });
        const throwingAgent = await throwingSystem.create(ctx, {});
        throwingAgent.state.tools = [routineTool, escalatingTool, externalTool];
        await throwingAgent.send(ctx, user("publish it"), { await: true });
        await throwingAgent.waitForIdle();
        expect(toolResults(throwingProvider).join("\n")).toContain("reviewed and refused");
        await throwingSystem.close(ctx);
    });
});

/** A single inference turn that emits three reviewable `publish` calls the reviewer denies. */
function threeDeniedPublishTurn(): SessionEvent[] {
    return [
        { type: "toolcall_start", callId: "call-1", name: "publish" },
        { type: "toolcall_end", callId: "call-1", arguments: JSON.stringify({ target: "a" }) },
        { type: "toolcall_start", callId: "call-2", name: "publish" },
        { type: "toolcall_end", callId: "call-2", arguments: JSON.stringify({ target: "b" }) },
        { type: "toolcall_start", callId: "call-3", name: "publish" },
        { type: "toolcall_end", callId: "call-3", arguments: JSON.stringify({ target: "c" }) },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}
