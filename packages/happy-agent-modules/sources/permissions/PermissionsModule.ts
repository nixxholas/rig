import type {
    AgentBasePermissionModeChange,
    AgentBaseToolCall,
    AgentBaseToolCallDecision,
    AgentModule,
    AgentModuleScope,
    AgentPermissionMode,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { describePermissionAction } from "./impl/describePermissionAction.js";
import { permissionModeGuidance } from "./impl/permissionModeGuidance.js";
import {
    deniedRefusal,
    outOfModeRefusal,
    turnStoppedNotice,
    unprovenRefusal,
} from "./impl/permissionRefusalMessage.js";
import type { PermissionEvent, PermissionModuleListener } from "./PermissionEvent.js";
import type { PermissionReviewDecision, PermissionReviewer } from "./PermissionReviewer.js";

/** What a permissions module is built with. */
export interface PermissionsModuleOptions {
    /**
     * Who decides, on the user's behalf, whether one Auto action may go ahead. Without a reviewer
     * every action that asks for one is refused as unproven: Auto never lets an unreviewed action
     * through, and never turns the question into one for the person.
     */
    readonly reviewer?: PermissionReviewer;
    /** Told about every mode change and every decision, as they happen. */
    readonly listener?: PermissionModuleListener;
    /** How long a review may take before the action counts as unreviewed. */
    readonly reviewTimeoutMs?: number;
    /** How many refusals in a row end the turn. */
    readonly refusalsBeforeStopping?: number;
}

/** A review that ended without a decision, which is not the same as one that refused. */
type ReviewOutcome = PermissionReviewDecision | { readonly outcome: "unproven"; reason: string };

/** Long enough for a real reviewer to think, short enough that a turn is never left hanging. */
const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;

/**
 * How many refused actions in a row end a turn. Nothing outside the agent breaks a refusal loop
 * once the person is no longer in it, so a turn that keeps being refused has to stop itself.
 */
const DEFAULT_REFUSALS_BEFORE_STOPPING = 3;

/**
 * Permission modes, enforced.
 *
 * The runtime carries the mode an agent runs in and makes its changes durable, but it enforces
 * nothing: it cannot know what any particular tool touches. This module is what turns the mode
 * into behavior. It tells the model what it is working under and decides what each tool call is
 * allowed to do in the mode in force — including whether an allowed Auto action is run with the
 * access it was reviewed for, for that one call and no longer. It decides only: the agent is what
 * runs the call, and what runs it under what was decided here.
 *
 * What it decides, per call:
 *
 * - A tool that declares it cannot be contained by Rig's sandbox is unavailable in Read only and
 *   Workspace write, and is refused without a review, since there is nothing to review.
 * - Outside Auto nothing is reviewed and nothing is elevated. The mode simply travels on the
 *   context, and the tools that act on the machine obey it.
 * - In Auto, a call the tool says needs reviewing is put to the reviewer. Allowed, it runs — under
 *   Full access when, and only when, the tool says this invocation cannot be carried out inside
 *   the sandbox. Refused, it becomes an error result the model is told is final. Unanswered, it
 *   becomes an error result the model is told is unproven, because a reviewer that timed out or
 *   was never there has judged nothing.
 *
 * Review is automatic and never becomes a question for the person. A tool whose own decision
 * throws is treated as needing review rather than as needing none, so a broken predicate cannot
 * quietly widen what an agent may do.
 *
 * The mode itself is not this module's to own or to keep. The agent carries it, makes its changes
 * durable, and hands it to every hook; changing it means steering the agent a message that says so,
 * which is what makes the new mode take effect exactly where the conversation shows it did. One
 * instance serves every agent in a collection, holding nothing per agent but a count of refusals.
 */
export class PermissionsModule implements AgentModule {
    readonly name = "permissions";

    /** Who decides in Auto, when anyone does. */
    readonly #reviewer: PermissionReviewer | undefined;
    /** Whoever is told about modes and decisions, if anyone. */
    readonly #listener: PermissionModuleListener | undefined;
    /** How long a review may take before the action counts as unreviewed. */
    readonly #reviewTimeoutMs: number;
    /** How many refusals in a row end the turn. */
    readonly #refusalsBeforeStopping: number;
    /** The collection this module belongs to, kept from the moment it starts. */
    #agents: AgentSystemRef | undefined;
    /** Refusals in a row, per agent, counted within one run and cleared when it settles. */
    readonly #refusals = new Map<string, number>();

    constructor(options: PermissionsModuleOptions) {
        this.#reviewer = options.reviewer;
        this.#listener = options.listener;
        this.#reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
        this.#refusalsBeforeStopping =
            options.refusalsBeforeStopping ?? DEFAULT_REFUSALS_BEFORE_STOPPING;
    }

    /**
     * Keep the collection the module is part of. It is what lets a turn drowning in refusals be
     * stopped.
     */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): Promise<void> => {
        this.#agents = agents;
        return Promise.resolve();
    };

    readonly instructions = (_ctx: Context, scope: AgentModuleScope): string =>
        permissionModeGuidance(scope.agent.permissionMode);

    /**
     * Announce a change inside the transaction that commits it, so a listener keeping its own
     * record of what an agent was allowed to do commits that record with the change itself.
     */
    readonly permissionModeChangedTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        change: AgentBasePermissionModeChange,
    ): Promise<void> => {
        await this.#listener?.onEventTransactional?.(ctx, {
            type: "permission_mode_changed",
            agentId: scope.agent.id,
            previousMode: change.previousMode,
            mode: change.mode,
        });
    };

    readonly permissionModeChanged = (
        ctx: Context,
        scope: AgentModuleScope,
        change: AgentBasePermissionModeChange,
    ): void => {
        this.#announce(ctx, {
            type: "permission_mode_changed",
            agentId: scope.agent.id,
            previousMode: change.previousMode,
            mode: change.mode,
        });
    };

    /** A run that is over takes its refusals with it; the next one starts from nothing. */
    readonly afterAgentSettled = (_ctx: Context, scope: AgentModuleScope): void => {
        this.#refusals.delete(scope.agent.id);
    };

    /**
     * Decide what this one call is allowed to do. Everything the decision needs comes from the
     * tool itself: whether it can be contained at all, whether this invocation needs reviewing,
     * and whether allowing it means lifting the sandbox for its length. The module decides only;
     * running the call, and running it under what was decided, belongs to the agent.
     */
    readonly beforeToolCall = async (
        ctx: Context,
        scope: AgentModuleScope,
        call: AgentBaseToolCall,
    ): Promise<AgentBaseToolCallDecision | undefined> => {
        const agentId = scope.agent.id;
        const mode = scope.agent.permissionMode;
        const tool = call.tool;
        const name = toolName(tool);
        if (
            tool.requiresAutoOrFullAccess === true &&
            (mode === "read_only" || mode === "workspace_write")
        ) {
            this.#announce(ctx, {
                type: "permission_action_out_of_mode",
                agentId,
                callId: call.callId,
                tool: name,
                mode,
            });
            return await this.#refuse(ctx, agentId, outOfModeRefusal(name, mode));
        }
        if (mode !== "auto") return this.#allow(agentId);
        if (!(await this.#needsReview(ctx, tool, call.arguments))) {
            return this.#allow(agentId);
        }
        const action = describePermissionAction(tool, call.arguments, ctx);
        const elevates = await this.#elevates(ctx, tool, call.arguments);
        const decision = await this.#review(ctx, {
            agentId,
            callId: call.callId,
            tool,
            arguments: call.arguments,
            action,
            mode,
            elevates,
        });
        if (decision.outcome === "denied") {
            this.#announce(ctx, {
                type: "permission_action_denied",
                agentId,
                callId: call.callId,
                tool: name,
                action,
                reason: decision.reason,
            });
            return await this.#refuse(ctx, agentId, deniedRefusal(action, decision.reason));
        }
        if (decision.outcome === "unproven") {
            this.#announce(ctx, {
                type: "permission_action_unproven",
                agentId,
                callId: call.callId,
                tool: name,
                action,
                reason: decision.reason,
            });
            return await this.#refuse(ctx, agentId, unprovenRefusal(action, decision.reason));
        }
        this.#announce(ctx, {
            type: "permission_action_reviewed",
            agentId,
            callId: call.callId,
            tool: name,
            action,
            elevated: elevates,
        });
        // The elevation is the call's, not the agent's: it applies to this one execution, so the
        // mode the agent runs in is untouched and the next call is decided again.
        return this.#allow(agentId, elevates);
    };

    /** Let the call through, and forget the refusals that came before it. */
    #allow(agentId: string, elevated = false): AgentBaseToolCallDecision | undefined {
        this.#refusals.delete(agentId);
        return elevated ? { type: "run", permissionMode: "full_access" } : undefined;
    }

    /**
     * Refuse the call, and end the turn when refusals have piled up. A refusal is what the model
     * is told this call produced, in place of anything the tool would have done; a turn that keeps
     * collecting them is going nowhere, and nothing outside the agent is left to stop it, so it
     * stops itself.
     */
    async #refuse(
        ctx: Context,
        agentId: string,
        message: string,
    ): Promise<AgentBaseToolCallDecision> {
        const refusals = (this.#refusals.get(agentId) ?? 0) + 1;
        this.#refusals.set(agentId, refusals);
        if (refusals < this.#refusalsBeforeStopping) return refusal(message);
        this.#refusals.delete(agentId);
        this.#announce(ctx, { type: "permission_turn_stopped", agentId, refusals });
        try {
            await this.#agents?.abort(ctx, agentId);
        } catch {
            // The refusal stands whether or not the turn could be cancelled.
        }
        return refusal(`${message}\n\n${turnStoppedNotice(refusals)}`);
    }

    /**
     * Whether this invocation has to be reviewed. A tool owns the decision; one whose predicate
     * fails has not said no, and an unanswered question is reviewed rather than waved through.
     */
    async #needsReview(ctx: Context, tool: AnyAgentTool, args: unknown): Promise<boolean> {
        try {
            return (await tool.shouldReviewInAutoMode(args, ctx)) === true;
        } catch {
            return true;
        }
    }

    /**
     * Whether an approval also has to lift the sandbox for the length of this call. Review and
     * elevation are separate decisions: an action is elevated only because the tool says this
     * invocation cannot be carried out inside the sandbox, never because it was reviewed.
     */
    async #elevates(ctx: Context, tool: AnyAgentTool, args: unknown): Promise<boolean> {
        try {
            return (await tool.shouldRunInFullAccessInAutoMode?.(args, ctx)) === true;
        } catch {
            return false;
        }
    }

    /**
     * Put one action to the reviewer, within a bounded time. A reviewer that is absent, throws, or
     * takes too long has refused nothing: the outcome is unproven, and the model is told as much
     * rather than being told the action was judged unsafe.
     */
    async #review(
        ctx: Context,
        request: {
            readonly agentId: string;
            readonly callId: string;
            readonly tool: AnyAgentTool;
            readonly arguments: unknown;
            readonly action: string;
            readonly mode: AgentPermissionMode;
            readonly elevates: boolean;
        },
    ): Promise<ReviewOutcome> {
        const reviewer = this.#reviewer;
        if (reviewer === undefined) {
            return {
                outcome: "unproven",
                reason: "This agent has no permission reviewer, so nothing can approve an action that leaves the sandbox.",
            };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<ReviewOutcome>((resolve) => {
                timer = setTimeout(
                    () =>
                        resolve({
                            outcome: "unproven",
                            reason: `The reviewer did not answer within ${Math.round(this.#reviewTimeoutMs / 1000)} seconds.`,
                        }),
                    this.#reviewTimeoutMs,
                );
                timer.unref?.();
            });
            return await Promise.race([reviewer.review(ctx, request), timeout]);
        } catch (error: unknown) {
            return {
                outcome: "unproven",
                reason: `The reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    /** Tell the listener, if there is one, without letting it affect the run. */
    #announce(ctx: Context, event: PermissionEvent): void {
        try {
            this.#listener?.onEvent?.(ctx, event);
        } catch {
            // A listener observes permissions; it never decides them.
        }
    }
}

/** A refused call, as the error result the model is told the call produced. */
function refusal(message: string): AgentBaseToolCallDecision {
    return { type: "answer", content: [{ type: "text", text: message }], isError: true };
}

/** How a tool is named in something a person or a model reads. */
function toolName(tool: AnyAgentTool): string {
    return tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
}
