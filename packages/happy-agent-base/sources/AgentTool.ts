import type {
    SessionOutputBlock,
    SessionToolLarkGrammar,
} from "@slopus/happy-providers";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/**
 * An executable tool with TypeBox-typed arguments and structured result. The descriptor fields
 * mirror the provider session tool. The agent validates arguments against `parameters` before
 * execute runs and the result against `returnType` after; `toLLM` renders the structured result
 * into model-facing content. A thrown execute, an invalid result, or `isError` returning true
 * becomes an error tool result for the model rather than failing the run.
 */
export interface AgentTool<
    Args extends TSchema = TSchema,
    Result extends TSchema = TSchema,
> {
    readonly name: string;
    readonly namespace?: string;
    /** Description of the containing namespace, when this tool is namespaced. */
    readonly namespaceDescription?: string;
    /**
     * Exact native tool descriptor for a call the provider owns and settles inside its response.
     * Absence means the agent owns execution.
     */
    readonly server?: { readonly type: string; readonly [key: string]: unknown };
    readonly description?: string;
    readonly parameters?: Args;
    readonly returnType: Result;
    /** Provider-neutral request to expose this tool through native tool discovery. */
    readonly defer?: boolean;
    /** Ignored by providers that do not support grammar-based tools. */
    readonly grammar?: SessionToolLarkGrammar;
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
    toLLM(result: Static<Result>): readonly SessionOutputBlock[];
    isError?(result: Static<Result>): boolean;
}

// Each tool keeps its concrete schemas; the agent needs one heterogeneous array, so this is the
// deliberate type-erased boundary. Arguments and results are validated against the concrete
// TypeBox schemas at runtime around every execution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, any>;

/** Define a tool with TypeBox-inferred argument and result types. */
export function defineAgentTool<
    const Args extends TSchema,
    const Result extends TSchema,
>(tool: AgentTool<Args, Result>): AgentTool<Args, Result> {
    return tool;
}
