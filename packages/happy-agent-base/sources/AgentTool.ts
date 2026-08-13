import type { SessionOutputBlock, SessionToolLarkGrammar } from "@slopus/happy-providers";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/** A tool-owned decision about one invocation while the agent is in Auto mode. */
export type AgentToolAutoPermissionPredicate<Args> = {
    bivarianceHack(args: Args, ctx: Context): boolean | Promise<boolean>;
}["bivarianceHack"];

/** Human-readable description of the exact action an Auto reviewer is deciding on. */
export type AgentToolAutoPermissionActionDescriber<Args> = {
    bivarianceHack(args: Args, ctx: Context): string;
}["bivarianceHack"];

/**
 * An executable tool with TypeBox-typed arguments and structured result. The descriptor fields
 * mirror the provider session tool. The agent validates arguments against `parameters` before
 * execute runs and the result against `returnType` after; `toLLM` renders the structured result
 * into model-facing content. A thrown execute, an invalid result, or `isError` returning true
 * becomes an error tool result for the model rather than failing the run.
 */
export interface AgentTool<Args extends TSchema = TSchema, Result extends TSchema = TSchema> {
    /** The tool name the model calls. */
    readonly name: string;
    /** Optional grouping the tool is exposed under, such as an MCP server name. */
    readonly namespace?: string;
    /** Description of the containing namespace, when this tool is namespaced. */
    readonly namespaceDescription?: string;
    /**
     * Exact native tool descriptor for a call the provider owns and settles inside its response.
     * Absence means the agent owns execution.
     */
    readonly server?: { readonly type: string; readonly [key: string]: unknown };
    /** Model-facing explanation of what the tool does and when to use it. */
    readonly description?: string;
    /** TypeBox schema the model's arguments are validated against before execute runs. */
    readonly parameters?: Args;
    /** TypeBox schema the structured result is validated against after execute runs. */
    readonly returnType: Result;
    /** Provider-neutral request to expose this tool through native tool discovery. */
    readonly defer?: boolean;
    /** Ignored by providers that do not support grammar-based tools. */
    readonly grammar?: SessionToolLarkGrammar;
    /**
     * Provider-shaped guidance shown only in Auto mode. Use this for fields the model must set
     * when it intentionally requests review or Full access.
     */
    readonly autoPermissionInstructions?: string;
    /**
     * Describes the exact action and boundary an Auto reviewer is deciding on. A tool whose
     * `shouldReviewInAutoMode` can return true must provide this description.
     */
    readonly describeAutoPermissionAction?: AgentToolAutoPermissionActionDescriber<Static<Args>>;
    /**
     * The tool cannot be contained by Rig's local restricted modes, so it is available only in
     * Auto or Full access. This does not itself approve an Auto invocation.
     */
    readonly requiresAutoOrFullAccess?: boolean;
    /**
     * Whether this exact invocation requires an Auto review. Every tool owns this decision;
     * routine tools state that explicitly with a predicate that returns false.
     */
    readonly shouldReviewInAutoMode: AgentToolAutoPermissionPredicate<Static<Args>>;
    /**
     * Whether an approved invocation must temporarily run in Full access. Review and elevation
     * are deliberately separate decisions; omission means the current sandbox remains active.
     */
    readonly shouldRunInFullAccessInAutoMode?: AgentToolAutoPermissionPredicate<Static<Args>>;
    /**
     * A durable tool is safe to execute again, so an interrupted call is retried when the agent
     * restarts. A non-durable call interrupted by a restart becomes an error tool result instead.
     */
    readonly durable?: boolean;
    /**
     * The context's lifetime aborts when the turn is aborted, so a long-running tool can
     * observe cancellation and stop its own work.
     */
    execute(ctx: Context, args: Static<Args>): Promise<Static<Result>>;
    /** Renders a validated result into the content blocks the model actually sees. */
    toLLM(result: Static<Result>): readonly SessionOutputBlock[];
    /** Whether a structured result should be reported to the model as an error. */
    isError?(result: Static<Result>): boolean;
}

// Each tool keeps its concrete schemas; the agent needs one heterogeneous array, so this is the
// deliberate type-erased boundary. Arguments and results are validated against the concrete
// TypeBox schemas at runtime around every execution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, any>;

/** Define a tool with TypeBox-inferred argument and result types. */
export function defineAgentTool<const Args extends TSchema, const Result extends TSchema>(
    tool: AgentTool<Args, Result>,
): AgentTool<Args, Result> {
    return tool;
}
