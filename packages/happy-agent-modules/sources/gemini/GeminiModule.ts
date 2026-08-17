import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import { hostComputeSchema } from "../compute/ComputeModule.js";
import type { ComputeResolver } from "../compute/ComputeResolver.js";
import { FileReadLog } from "../compute/impl/FileReadLog.js";
import type { GeminiConnection } from "./Gemini.js";
import { geminiAnalyzeMediaTool } from "./tools/gemini_analyze_media.js";
import { geminiGenerateImageTool } from "./tools/gemini_imagegen.js";
import { geminiGenerateMusicTool } from "./tools/gemini_generate_music.js";

const exact = { additionalProperties: false } as const;
const contextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));

const computeResolverSchema = Type.Unsafe<ComputeResolver>(
    Type.Object(
        {
            resolve: Type.Function(
                [contextSchema, Type.String({ minLength: 1 })],
                Type.Promise(Type.Union([hostComputeSchema, Type.Undefined()])),
            ),
        },
        exact,
    ),
);

const fetchSchema = Type.Unsafe<typeof fetch>(Type.Function([Type.Any()], Type.Any()));

export const geminiModuleOptionsSchema = Type.Object(
    {
        /** The Gemini API key every call authenticates with. */
        apiKey: Type.String({ minLength: 1 }),
        /** How the module reaches the machine an agent works on, to read and write media files. */
        compute: computeResolverSchema,
        /** The transport requests go out on. Hosts leave this unset and get the global `fetch`. */
        fetch: Type.Optional(fetchSchema),
    },
    exact,
);

export type GeminiModuleOptions = Omit<
    Static<typeof geminiModuleOptionsSchema>,
    "compute" | "fetch"
> & {
    compute: ComputeResolver;
    fetch?: typeof fetch;
};

/**
 * Gemini's media tools: generate an image, generate music, and ask about a file already on the
 * machine.
 *
 * The module owns the Gemini calls itself — nothing is delegated to a host — and it owns nothing
 * else. There is no catalog, no event, and no record kept of what was made: a tool calls Gemini,
 * writes the file where the model asked for it, and answers with that path.
 */
export class GeminiModule implements AgentModule {
    readonly name = "gemini";
    readonly #connection: GeminiConnection;
    readonly #compute: ComputeResolver;
    /** One lock per agent, so two generations in the same turn cannot interleave their reads. */
    readonly #readLocks: MapAsyncLock<string> = mapAsyncLock<string>();

    constructor(options: GeminiModuleOptions) {
        if (!Value.Check(geminiModuleOptionsSchema, materializeOptions(options))) {
            throw new Error("Gemini module options are invalid.");
        }
        this.#compute = options.compute;
        this.#connection = {
            apiKey: options.apiKey,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        };
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // Every tool here either writes a file or reads one, so an agent without a machine to
            // work on has nothing to offer.
            const compute = await this.#compute.resolve(ctx, scope.agent.id);
            if (compute === undefined) return [];
            const reads = new FileReadLog(scope.kv, this.#readLocks, scope.agent.id);
            return [
                geminiGenerateImageTool(this.#connection, compute, reads),
                geminiGenerateMusicTool(this.#connection, compute, reads),
                geminiAnalyzeMediaTool(this.#connection, compute),
            ];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

/**
 * The resolver arrives as a class instance whose methods live on its prototype, which a closed
 * object schema cannot see. Project the one method the module actually uses so the check reads
 * what is really there.
 */
function materializeOptions(options: GeminiModuleOptions): unknown {
    if (options === null || typeof options !== "object") return options;
    const compute = (options as { compute?: ComputeResolver }).compute;
    return compute === undefined || compute === null || typeof compute !== "object"
        ? options
        : { ...options, compute: { resolve: compute.resolve } };
}
