import {
    withAgentConfig,
    type AgentConfig,
    type AgentMessageAcceptance,
    type AgentModel,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { CollaborationModule } from "../../sources/collaboration/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const MODELS: readonly AgentModel[] = [
    {
        providerId: "codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "medium",
        serviceTiers: ["priority"],
    },
    {
        providerId: "claude",
        id: "opus-5",
        name: "Opus 5",
        effortLevels: ["medium", "high"],
        defaultEffort: "medium",
    },
    {
        providerId: "bedrock",
        id: "opus-5",
        name: "Opus 5",
        effortLevels: ["medium"],
        defaultEffort: "medium",
    },
];

interface Delivery {
    readonly toAgentId: string;
    readonly text: string;
    readonly options: Record<string, unknown>;
}

/**
 * A stand-in for the agent collection. It records exactly what the module asked of it, which is
 * the whole contract now that the module keeps no state of its own.
 */
class Collection {
    readonly configs = new Map<string, AgentConfig>();
    readonly parents = new Map<string, string | null>();
    readonly created: Array<{ readonly id: string; readonly parent: string | null }> = [];
    readonly delivered: Delivery[] = [];
    readonly aborted: string[] = [];

    readonly models = MODELS;

    /** Register an agent that already exists, as the collection would after a restart. */
    seed(id: string, parent: string | null): void {
        this.configs.set(id, {});
        this.parents.set(id, parent);
    }

    async config(_ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return this.configs.get(agentId);
    }

    async parentOf(_ctx: Context, agentId: string): Promise<string | null> {
        return this.parents.get(agentId) ?? null;
    }

    async childOf(_ctx: Context, agentId: string): Promise<readonly string[]> {
        return [...this.parents.entries()]
            .filter(([, parent]) => parent === agentId)
            .map(([id]) => id);
    }

    async create(
        _ctx: Context,
        config: AgentConfig,
        options: { readonly id?: string; readonly parent?: string | null },
    ): Promise<{ readonly id: string }> {
        const id = options.id ?? "generated";
        if (this.configs.has(id)) throw new Error(`Agent "${id}" already exists.`);
        this.configs.set(id, config);
        this.parents.set(id, options.parent ?? null);
        this.created.push({ id, parent: options.parent ?? null });
        return { id };
    }

    async send(
        _ctx: Context,
        agentId: string,
        message: { readonly content: readonly { readonly text: string }[] },
        options: Record<string, unknown>,
    ): Promise<AgentMessageAcceptance> {
        this.delivered.push({
            toAgentId: agentId,
            text: message.content[0]!.text,
            options,
        });
        return { id: options.id as string, delivery: "send", accepted: "created" };
    }

    async abort(_ctx: Context, agentId: string): Promise<void> {
        this.aborted.push(agentId);
    }

    /** The module holds an `AgentSystemRef`; this stub supplies only what it actually calls. */
    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

async function started(
    collection: Collection,
): Promise<{ module: CollaborationModule; hooks: AgentModuleHooks; ctx: Context }> {
    const module = new CollaborationModule();
    const ctx = withAgentConfig(createRootContext().named("collaboration-test"), {
        environment: {
            osVersion: "test",
            platform: "darwin",
            workingDirectory: "/work",
            shell: "/bin/zsh",
        },
        modules: { collaboration: {} },
        metadata: { title: "Parent agent" },
    });
    const hooks = await resolveModuleHooks(ctx, module, collection.asRef());
    return { module, hooks, ctx };
}

/** A stand-in run store; the module only ever keeps one note in it. */
function runScope(agentId: string) {
    const values = new Map<string, unknown>();
    return {
        agent: { id: agentId },
        runKV: {
            read: async (_ctx: Context, key: string) => values.get(key),
            write: async (_ctx: Context, key: string, value: unknown) => {
                values.set(key, value);
            },
        },
    } as never;
}

function textEnd(text: string) {
    return { type: "text_end", block: { type: "text", text } } as never;
}

function settlement(settlementId: string) {
    return { loopId: "loop", settlementId } as never;
}

const TASK = {
    title: "Reviewer",
    model: "gpt-5.6-sol",
    effort: "high",
    text: "Review the parser change.",
} as const;

describe("collaboration", () => {
    it("creates a collaborator as a child of its creator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        const result = await module.createAgent(ctx, "parent", TASK, "child");

        expect(result).toEqual({ agentId: "child" });
        expect(collection.created).toEqual([{ id: "child", parent: "parent" }]);
    });

    it("puts the collaborator's name in the agent's real metadata", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.configs.get("child")?.metadata).toEqual({ title: "Reviewer" });
    });

    it("gives a collaborator the machine its creator works on", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.configs.get("child")?.environment?.workingDirectory).toBe("/work");
        expect(collection.configs.get("child")?.modules).toEqual({ collaboration: {} });
    });

    it("chooses what a collaborator runs on with the message that starts it", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(
            ctx,
            "parent",
            { ...TASK, provider: "codex", serviceTier: "priority" },
            "child",
        );

        expect(collection.delivered).toHaveLength(1);
        expect(collection.delivered[0]!.options).toMatchObject({
            model: "gpt-5.6-sol",
            effort: "high",
            provider: "codex",
            serviceTier: "priority",
        });
    });

    it("never lets a later message change what a collaborator runs on", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.sendMessage(
            ctx,
            "parent",
            { toAgentId: "child", text: "One more thing." },
            "m1",
        );

        const followUp = collection.delivered[1]!.options;
        expect(followUp).not.toHaveProperty("model");
        expect(followUp).not.toHaveProperty("effort");
        expect(followUp).not.toHaveProperty("provider");
        expect(followUp).not.toHaveProperty("serviceTier");
        expect(followUp).not.toHaveProperty("permissionMode");
    });

    it("names the sender in the text, because that is the address a reply goes to", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.delivered[0]!.text).toBe(
            "Message from agent parent:\n\nReview the parser change.",
        );
    });

    it("delivers under the durable tool call's own identity", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");
        await module.sendMessage(ctx, "parent", { toAgentId: "child", text: "Again." }, "call-2");

        expect(collection.delivered.map(({ options }) => options.id)).toEqual(["child", "call-2"]);
    });

    it("does not create a collaborator twice when its durable call is retried", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");
        await module.createAgent(ctx, "parent", TASK, "child");

        // Creating again would throw; the retry recognises the identity the collection already
        // holds and only redoes delivery, which Agent Base settles by message ID.
        expect(collection.created).toHaveLength(1);
    });

    it("refuses a model the collection does not offer", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(ctx, "parent", { ...TASK, model: "imaginary" }, "child"),
        ).rejects.toThrow('Model "imaginary" is not available for collaborators.');
        expect(collection.created).toHaveLength(0);
    });

    it("refuses an effort the chosen model does not support", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(
                ctx,
                "parent",
                { ...TASK, effort: "low", model: "opus-5", provider: "claude" },
                "child",
            ),
        ).rejects.toThrow('Effort "low" is not available for collaborator model "opus-5".');
    });

    it("asks for a provider when a model name alone is ambiguous", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(ctx, "parent", { ...TASK, model: "opus-5" }, "child"),
        ).rejects.toThrow("available from more than one provider");
    });

    it("refuses a service tier the chosen model does not offer", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(
                ctx,
                "parent",
                { ...TASK, model: "opus-5", provider: "claude", serviceTier: "priority" },
                "child",
            ),
        ).rejects.toThrow('Service tier "priority" is not available');
    });

    it("lets a collaborator answer the agent that created it", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.sendMessage(ctx, "child", { toAgentId: "parent", text: "Done." }, "m1");

        expect(collection.delivered[1]).toMatchObject({
            toAgentId: "parent",
            text: "Message from agent child:\n\nDone.",
        });
    });

    it("refuses a message between agents with no relationship", async () => {
        const collection = new Collection();
        collection.seed("stranger", null);
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await expect(
            module.sendMessage(ctx, "child", { toAgentId: "stranger", text: "Hello." }, "m1"),
        ).rejects.toThrow('Agent "child" is not authorized to send to agent "stranger".');
    });

    it("interrupts a collaborator it created", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.interruptAgent(ctx, "parent", "child");

        expect(collection.aborted).toEqual(["child"]);
    });

    it("refuses to interrupt an agent it has no relationship with", async () => {
        const collection = new Collection();
        collection.seed("stranger", null);
        const { module, hooks, ctx } = await started(collection);

        await expect(module.interruptAgent(ctx, "parent", "stranger")).rejects.toThrow(
            "is not authorized to interrupt",
        );
        expect(collection.aborted).toEqual([]);
    });

    it("tells a collaborator the address to answer on", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        // The sender's name is in the delivered message too, but that line ages out of history on
        // compaction while the relationship does not.
        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "child" },
        } as never);

        expect(instructions).toContain("created by agent parent");
        expect(instructions).toContain("send_agent_message");
    });

    it("tells an agent which collaborators it created", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "parent" },
        } as never);

        expect(instructions).toContain("Collaborators you created: child.");
    });

    it("says nothing to an agent with no collaborators at all", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        expect(await hooks.instructions!(ctx, { agent: { id: "lonely" } } as never)).toBe("");
    });

    it("reports a collaborator's last words to its creator when it stops working", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("The parser change looks correct."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]).toMatchObject({
            toAgentId: "parent",
            text: "Collaborator child finished working. Its answer follows, verbatim.\n\nThe parser change looks correct.",
        });
    });

    it("marks the report so it can be shown as a notice rather than as someone talking", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Done."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.options.metadata).toEqual({
            collaboration: {
                kind: "subagent_report",
                fromAgentId: "child",
                toAgentId: "parent",
            },
            senderAgentId: "child",
        });
    });

    it("says nothing when the collaborator finished in silence", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        // No text_end ever arrived — an interrupted turn, or one that was told no action was
        // needed. There is no answer to pass on, and announcing the silence would tell the
        // creator something it already knows.
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(1);
    });

    it("reports under the settlement's identity, so a retry is not a second report", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Done."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.options.id).toBe("s1");
    });

    it("says nothing upward when the agent that stopped has no creator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const scope = runScope("root");

        await hooks.onEventTransact!(ctx, scope, textEnd("All done."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(0);
    });

    it("keeps only the most recent thing the model said", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Thinking out loud."));
        await hooks.onEventTransact!(ctx, scope, textEnd("Final answer."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.text).toContain("Final answer.");
        expect(collection.delivered[1]!.text).not.toContain("Thinking out loud.");
    });

    it("declares only the retirement of the schema it used to keep", () => {
        // Agents are actors: the inbox, the ancestry, and the identity all belong to Agent Base,
        // so this module owns no table. The released keys stay because Agent Base requires the
        // applied migrations to remain a prefix of the declared ones — drop one of these and
        // every database that ran an earlier build refuses to open.
        expect(new CollaborationModule().migrations.map(([key]) => key)).toEqual([
            "001-collaboration",
            "002-drop-collaboration-receipts",
            "003-collaboration-run-state",
            "004-collaboration-storage-removed",
        ]);
    });

    it("refuses to work before the agent collection is available", async () => {
        const module = new CollaborationModule();
        const ctx = createRootContext().named("unstarted");

        await expect(module.createAgent(ctx, "parent", TASK, "child")).rejects.toThrow(
            "has not been started yet",
        );
    });
});
