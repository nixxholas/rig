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
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { describePermissionAction } from "./impl/describePermissionAction.js";
import {
    autoPermissionPolicyDenialReason,
    shouldAllowAutoPermissionReview,
} from "./impl/shouldAllowAutoPermissionReview.js";
import { PermissionRefusalCircuitBreaker } from "./impl/permissionRefusalCircuitBreaker.js";
import { permissionModeGuidance } from "./impl/permissionModeGuidance.js";
import {
    MAX_PERMISSION_ERROR_CHARACTERS,
    deniedRefusal,
    missingPermissionActionRefusal,
    outOfModeRefusal,
    permissionRequestRefusal,
    turnStoppedNotice,
    unprovenRefusal,
    type PermissionUnprovenKind,
} from "./impl/permissionRefusalMessage.js";
import {
    permissionModuleListenerSchema,
    type PermissionEvent,
    type PermissionModuleListener,
} from "./PermissionEvent.js";
import {
    MAX_PERMISSION_ACTION,
    permissionReviewRequestSchema,
    permissionReviewDecisionSchema,
    permissionReviewerSchema,
    type PermissionReviewDecision,
    type PermissionReviewRequest,
    type PermissionReviewer,
} from "./PermissionReviewer.js";
import {
    mergePermissionToolGuidances,
    permissionToolGuidanceProviderSchema,
    permissionToolGuidancesSchema,
    type PermissionToolGuidanceProvider,
    type PermissionToolGuidances,
} from "./PermissionToolGuidance.js";
import { snapshotPermissionArguments } from "./impl/snapshotPermissionArguments.js";

const permissionContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);
const permissionAgentIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const killAllSessionsSchema = Type.Function(
    [permissionContextSchema, permissionAgentIdSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

/**
 * Runtime-checked construction boundary for the module. The cleanup seam is required because a
 * committed reduction must always have a host capability that can terminate elevated sessions.
 */
export const permissionsModuleOptionsSchema = Type.Object(
    {
        reviewer: Type.Optional(permissionReviewerSchema),
        listener: Type.Optional(permissionModuleListenerSchema),
        toolGuidance: Type.Optional(Type.Readonly(permissionToolGuidancesSchema)),
        toolGuidanceProvider: Type.Optional(permissionToolGuidanceProviderSchema),
        killAllSessions: killAllSessionsSchema,
        reviewTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
        refusalsBeforeStopping: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
);

/** What a permissions module is built with. */
export type PermissionsModuleOptions = Static<typeof permissionsModuleOptionsSchema>;

/** A review that ended without a decision, which is not the same as one that refused. */
type ReviewOutcome =
    | PermissionReviewDecision
    | {
          readonly outcome: "unproven";
          readonly kind: PermissionUnprovenKind;
          readonly reason: string;
      };
/** Long enough for a real reviewer to think, short enough that a turn is never left hanging. */
const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;
const MAX_REVIEW_TIMEOUT_MS = 600_000;

/**
 * How many refused actions in a row end a turn. Nothing outside the agent breaks a refusal loop
 * once the person is no longer in it, so a turn that keeps being refused has to stop itself.
 */
const DEFAULT_REFUSALS_BEFORE_STOPPING = 3;
const REVIEW_TIMEOUT = Symbol("permission-review-timeout");

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
 * instance serves every agent in a collection, holding only bounded refusal circuits per agent.
 */
export class PermissionsModule implements AgentModule {
    readonly name = "permissions";

    /** Who decides in Auto, when anyone does. */
    readonly #reviewer: PermissionReviewer | undefined;
    /** Whoever is told about modes and decisions, if anyone. */
    readonly #listener: PermissionModuleListener | undefined;
    /** Static or host-supplied guidance for the active tools. */
    readonly #toolGuidance: PermissionToolGuidances;
    readonly #toolGuidanceProvider: PermissionToolGuidanceProvider | undefined;
    /** Host-owned Compute seam used when a committed mode reduction tightens the boundary. */
    readonly #killAllSessions: (ctx: Context, agentId: string) => Promise<void> | void;
    /** How long a review may take before the action counts as unreviewed. */
    readonly #reviewTimeoutMs: number;
    /** How many refusals in a row end the turn. */
    readonly #refusalsBeforeStopping: number;
    /** The collection this module belongs to, kept from the moment it starts. */
    #agents: AgentSystemRef | undefined;
    /** One bounded circuit per agent, cleared when its run settles. */
    readonly #refusals = new Map<string, PermissionRefusalCircuitBreaker>();
    /** Serialize decisions for one agent so an in-flight call cannot outrun a refusal trip. */
    readonly #decisionTails = new Map<string, Promise<void>>();
    /** Delay clearing a circuit until queued decisions from the settled run have drained. */
    readonly #settledWhileBusy = new Set<string>();

    constructor(options: PermissionsModuleOptions) {
        if (!Value.Check(permissionsModuleOptionsSchema, options)) {
            throw new Error("Permissions module options are invalid.");
        }
        if (
            options.reviewer !== undefined &&
            !Value.Check(permissionReviewerSchema, options.reviewer)
        ) {
            throw new Error("Permissions module reviewer is invalid.");
        }
        if (
            options.listener !== undefined &&
            !Value.Check(permissionModuleListenerSchema, options.listener)
        ) {
            throw new Error("Permissions module listener is invalid.");
        }
        if (
            options.toolGuidanceProvider !== undefined &&
            !Value.Check(permissionToolGuidanceProviderSchema, options.toolGuidanceProvider)
        ) {
            throw new Error("Permissions module tool guidance provider is invalid.");
        }
        this.#reviewer = options.reviewer;
        this.#listener = options.listener;
        this.#toolGuidance = [...(options.toolGuidance ?? [])];
        this.#toolGuidanceProvider = options.toolGuidanceProvider;
        this.#killAllSessions = options.killAllSessions;
        this.#reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
        this.#refusalsBeforeStopping =
            options.refusalsBeforeStopping ?? DEFAULT_REFUSALS_BEFORE_STOPPING;
        if (
            !Number.isInteger(this.#reviewTimeoutMs) ||
            this.#reviewTimeoutMs < 1 ||
            this.#reviewTimeoutMs > MAX_REVIEW_TIMEOUT_MS
        ) {
            throw new Error("Permissions module review timeout is invalid.");
        }
        if (!Number.isInteger(this.#refusalsBeforeStopping) || this.#refusalsBeforeStopping < 1) {
            throw new Error("Permissions module refusal limit is invalid.");
        }
    }

    /**
     * Keep the collection the module is part of. It is what lets a turn drowning in refusals be
     * stopped.
     */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): Promise<void> => {
        this.#agents = agents;
        return Promise.resolve();
    };

    readonly instructions = async (ctx: Context, scope: AgentModuleScope): Promise<string> =>
        permissionModeGuidance(
            scope.agent.permissionMode,
            await this.#resolveToolGuidance(ctx, scope.agent.id),
        );

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

    readonly permissionModeChanged = async (
        ctx: Context,
        scope: AgentModuleScope,
        change: AgentBasePermissionModeChange,
    ): Promise<void> => {
        if (isPermissionReduction(change.previousMode, change.mode)) {
            try {
                await this.#killAllSessions(ctx, scope.agent.id);
            } catch (error: unknown) {
                this.#announce(ctx, {
                    type: "permission_mode_cleanup_failed",
                    agentId: scope.agent.id,
                    previousMode: change.previousMode,
                    mode: change.mode,
                    reason: safeErrorMessage(error),
                });
            }
        }
        this.#announce(ctx, {
            type: "permission_mode_changed",
            agentId: scope.agent.id,
            previousMode: change.previousMode,
            mode: change.mode,
        });
    };

    /** A run that is over takes its refusals with it; the next one starts from nothing. */
    readonly afterAgentSettled = (_ctx: Context, scope: AgentModuleScope): void => {
        if (this.#decisionTails.has(scope.agent.id)) {
            this.#settledWhileBusy.add(scope.agent.id);
            return;
        }
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
        const previous = this.#decisionTails.get(agentId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#decisionTails.set(agentId, current);
        await previous;
        try {
            return await this.#decideBeforeToolCall(ctx, scope, call);
        } finally {
            release();
            if (this.#decisionTails.get(agentId) === current) {
                this.#decisionTails.delete(agentId);
                if (this.#settledWhileBusy.delete(agentId)) {
                    this.#refusals.delete(agentId);
                }
            }
        }
    };

    readonly #decideBeforeToolCall = async (
        ctx: Context,
        scope: AgentModuleScope,
        call: AgentBaseToolCall,
    ): Promise<AgentBaseToolCallDecision | undefined> => {
        const agentId = scope.agent.id;
        const mode = scope.agent.permissionMode;
        const tool = call.tool;
        const name = toolName(tool);
        const stopped = this.#terminalRefusal(agentId);
        if (stopped !== undefined) return stopped;
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
        if (action === undefined) {
            return await this.#refuse(ctx, agentId, missingPermissionActionRefusal(name));
        }
        if (action.length > MAX_PERMISSION_ACTION) {
            return await this.#refuse(
                ctx,
                agentId,
                permissionRequestRefusal(
                    name,
                    `Its action description exceeds the ${MAX_PERMISSION_ACTION}-character limit.`,
                ),
            );
        }
        let reviewArguments: unknown;
        try {
            reviewArguments = snapshotPermissionArguments(call.arguments);
        } catch (error: unknown) {
            return await this.#refuse(
                ctx,
                agentId,
                permissionRequestRefusal(name, safeErrorMessage(error)),
            );
        }
        const elevates = await this.#elevates(ctx, tool, call.arguments);
        const reviewAbortController = new AbortController();
        const decision = await this.#review(
            ctx,
            {
                agentId,
                callId: call.callId,
                tool,
                arguments: reviewArguments,
                action,
                mode: "auto",
                elevates,
                signal: reviewAbortController.signal,
            },
            reviewAbortController,
        );
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
            return await this.#refuse(
                ctx,
                agentId,
                unprovenRefusal(action, decision.reason, decision.kind),
            );
        }
        if (!shouldAllowAutoPermissionReview(decision)) {
            const reason = autoPermissionPolicyDenialReason(decision);
            this.#announce(ctx, {
                type: "permission_action_denied",
                agentId,
                callId: call.callId,
                tool: name,
                action,
                reason,
            });
            return await this.#refuse(ctx, agentId, deniedRefusal(action, reason));
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

    /** Let the call through, clearing only the consecutive streak while the circuit is live. */
    #allow(agentId: string, elevated = false): AgentBaseToolCallDecision | undefined {
        let circuit = this.#refusals.get(agentId);
        const stopped = this.#terminalRefusal(agentId);
        if (stopped !== undefined) return stopped;
        if (circuit === undefined) {
            circuit = new PermissionRefusalCircuitBreaker(this.#refusalsBeforeStopping);
            this.#refusals.set(agentId, circuit);
        }
        if (!circuit.recordAllowed()) return this.#terminalRefusal(agentId);
        return elevated ? { type: "run", permissionMode: "full_access" } : undefined;
    }

    /** A tripped circuit stays closed until the agent settles. */
    #terminalRefusal(agentId: string): AgentBaseToolCallDecision | undefined {
        const circuit = this.#refusals.get(agentId);
        if (circuit === undefined || !circuit.stopped) return undefined;
        const status = circuit.status();
        return refusal(turnStoppedNotice(status.consecutive, status.recent));
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
        let circuit = this.#refusals.get(agentId);
        if (circuit === undefined) {
            circuit = new PermissionRefusalCircuitBreaker(this.#refusalsBeforeStopping);
            this.#refusals.set(agentId, circuit);
        }
        const status = circuit.recordRefusal();
        if (!status.newlyStopped) {
            return refusal(
                status.stopped
                    ? `${message}\n\n${turnStoppedNotice(status.consecutive, status.recent)}`
                    : message,
            );
        }
        this.#announce(ctx, {
            type: "permission_turn_stopped",
            agentId,
            refusals: Math.max(status.consecutive, status.recent),
        });
        try {
            await this.#agents?.abort(ctx, agentId);
        } catch {
            // The refusal stands whether or not the turn could be cancelled.
        }
        return refusal(`${message}\n\n${turnStoppedNotice(status.consecutive, status.recent)}`);
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

    async #resolveToolGuidance(ctx: Context, agentId: string): Promise<PermissionToolGuidances> {
        const supplied =
            this.#toolGuidanceProvider === undefined
                ? []
                : await this.#toolGuidanceProvider(ctx, agentId);
        return mergePermissionToolGuidances([this.#toolGuidance, supplied]);
    }

    /**
     * Put one action to the reviewer, within a bounded time. A reviewer that is absent, throws, or
     * takes too long has refused nothing: the outcome is unproven, and the model is told as much
     * rather than being told the action was judged unsafe.
     */
    async #review(
        ctx: Context,
        request: PermissionReviewRequest,
        abortController: AbortController,
    ): Promise<ReviewOutcome> {
        const reviewer = this.#reviewer;
        if (reviewer === undefined) {
            return {
                outcome: "unproven",
                kind: "unavailable",
                reason: "This agent has no permission reviewer, so nothing can approve an action that leaves the sandbox.",
            };
        }
        const reviewRequest = Object.freeze(request);
        if (!Value.Check(permissionReviewRequestSchema, reviewRequest)) {
            return {
                outcome: "unproven",
                kind: "unavailable",
                reason: "The automatic permission reviewer request was invalid.",
            };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<typeof REVIEW_TIMEOUT>((resolve) => {
                timer = setTimeout(() => resolve(REVIEW_TIMEOUT), this.#reviewTimeoutMs);
                timer.unref?.();
            });
            const reviewPromise = reviewer.review(ctx, reviewRequest);
            // A reviewer may reject after the timeout; keep that late settlement from becoming an
            // unhandled rejection while the turn has already moved on.
            void reviewPromise.catch(() => undefined);
            const candidate = await Promise.race([reviewPromise, timeout]);
            if (candidate === REVIEW_TIMEOUT) {
                abortController.abort();
                return {
                    outcome: "unproven",
                    kind: "timed_out",
                    reason: `The reviewer did not answer within ${Math.max(1, Math.ceil(this.#reviewTimeoutMs / 1000))} seconds.`,
                };
            }
            if (!Value.Check(permissionReviewDecisionSchema, candidate)) {
                return {
                    outcome: "unproven",
                    kind: "unavailable",
                    reason: "The automatic permission reviewer returned an invalid decision.",
                };
            }
            return candidate;
        } catch (error: unknown) {
            return {
                outcome: "unproven",
                kind: "unavailable",
                reason: `The reviewer failed: ${safeErrorMessage(error)}`,
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

const PERMISSION_MODE_RANK: Readonly<Record<AgentPermissionMode, number>> = {
    read_only: 0,
    workspace_write: 1,
    auto: 2,
    full_access: 3,
};

function isPermissionReduction(
    previousMode: AgentPermissionMode,
    mode: AgentPermissionMode,
): boolean {
    return PERMISSION_MODE_RANK[mode] < PERMISSION_MODE_RANK[previousMode];
}

function safeErrorMessage(error: unknown): string {
    try {
        if (error instanceof Error && error.message.length > 0) {
            return error.message.slice(0, MAX_PERMISSION_ERROR_CHARACTERS);
        }
    } catch {
        return "The reviewer failed without a readable error.";
    }
    try {
        const text = String(error);
        const message = text.length > 0 ? text : "The reviewer failed without a readable error.";
        return message.slice(0, MAX_PERMISSION_ERROR_CHARACTERS);
    } catch {
        return "The reviewer failed without a readable error.";
    }
}
