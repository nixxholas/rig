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
    PermissionsModule,
    permissionModeChangeNotice,
    type PermissionEvent,
    type PermissionReviewDecision,
    type PermissionReviewRequest,
    type PermissionReviewer,
} from "../../sources/index.js";
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
    } = {},
) {
    const world = agentWorld();
    const provider = new ScriptedProvider(script);
    const permissions = new PermissionsModule({
        ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
        ...(options.refusalsBeforeStopping === undefined
            ? {}
            : { refusalsBeforeStopping: options.refusalsBeforeStopping }),
        ...(options.events === undefined
            ? {}
            : { listener: { onEvent: (_eventCtx, event) => options.events?.push(event) } }),
    });
    const agent = await Agent.create(ctx, {
        id: agentId,
        providers: providersOf(provider),
        provider: "scripted",
        persistence: world.storage.persistence(agentId),
        sharedKV: sharedKV(),
        modules: [permissions],
        initialState: { tools: [routineTool, escalatingTool, externalTool] },
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

describe("PermissionsModule", () => {
    it("runs a reviewed action under Full access, and only for that call", async () => {
        ran.length = 0;
        const reviewer = reviewerAnswering(() => ({ outcome: "allowed" }));
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

    it("keeps a tool that leaves the sandbox out of the restricted modes, without a review", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({ outcome: "allowed" }));
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

    it("stops a turn that keeps being refused", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => ({
            outcome: "denied",
            reason: "Not authorized.",
        }));
        const world = agentWorld();
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
                { type: "toolcall_start", callId: "call-3", name: "publish" },
                {
                    type: "toolcall_end",
                    callId: "call-3",
                    arguments: JSON.stringify({ target: "c" }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("never asked again"),
        ]);
        const permissions = new PermissionsModule({
            reviewer,
            refusalsBeforeStopping: 2,
            listener: { onEvent: (_eventCtx, event) => events.push(event) },
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
        // The turn was cancelled, so the model was never asked to carry on after the refusals.
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await system.close(ctx);
    });

    it("enforces the mode a steered message made effective", async () => {
        ran.length = 0;
        const events: PermissionEvent[] = [];
        const world = agentWorld();
        const provider = new ScriptedProvider([
            textTurn("noted"),
            toolCallTurn("call-1", "look", "{}"),
            textTurn("looked"),
        ]);
        const permissions = new PermissionsModule({
            listener: { onEvent: (_eventCtx, event) => events.push(event) },
        });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
            modules: [permissions],
        });
        const agent = await system.create(ctx, {});
        agent.state.tools = [routineTool, escalatingTool, externalTool];

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
});
