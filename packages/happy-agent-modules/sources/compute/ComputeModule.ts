import {
    agentModuleConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import {
    hostComputeProvider,
    type Compute,
    type HostComputeConfig,
} from "@slopus/happy-agent-compute";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import type { ComputeSessionActivity, ComputeSessionSnapshot } from "./Compute.js";
import { computeToolVendor, type ComputeToolVendor } from "./ComputeToolVendor.js";
import { computeInstructionsForVendor } from "./impl/computeInstructionsForVendor.js";
import { FileReadLog } from "./impl/FileReadLog.js";
import { assembleComputeTools } from "./tools/assembleComputeTools.js";
import { assembleReviewerTools } from "./tools/assembleReviewerTools.js";

const exact = { additionalProperties: false } as const;
const callableSchema = Type.Function([], Type.Any());
const contextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));

const computeFileSystemSchema = Type.Object(
    {
        cwd: Type.String(),
        home: Type.Optional(Type.String()),
        chmod: callableSchema,
        exists: callableSchema,
        lstat: callableSchema,
        lstatMany: callableSchema,
        mkdir: callableSchema,
        move: callableSchema,
        realpath: callableSchema,
        readFile: callableSchema,
        readFileBuffer: callableSchema,
        readdir: callableSchema,
        readdirPage: callableSchema,
        rm: callableSchema,
        setModificationTime: callableSchema,
        stat: callableSchema,
        writeFile: callableSchema,
    },
    exact,
);

const computeShellSchema = Type.Object(
    {
        cwd: Type.String(),
        activeSessionCount: Type.Optional(callableSchema),
        activeSessions: Type.Optional(callableSchema),
        detachSession: Type.Optional(callableSchema),
        interruptSession: Type.Optional(callableSchema),
        killAllSessions: Type.Optional(callableSchema),
        killSession: callableSchema,
        readSession: callableSchema,
        run: callableSchema,
        sessionUsesSecrets: Type.Optional(callableSchema),
        setActiveSessionCountListener: Type.Optional(callableSchema),
        setSessionExitListener: Type.Optional(callableSchema),
        startSession: callableSchema,
        supportsSessionInput: Type.Boolean(),
        writeSession: callableSchema,
    },
    exact,
);

/** The host compute resolved for one agent. */
export type HostCompute = Compute & { readonly kind: "host" };

export const hostComputeSchema = Type.Unsafe<HostCompute>(
    Type.Object(
        {
            id: Type.Literal("host"),
            kind: Type.Literal("host"),
            cwd: Type.String({ minLength: 1 }),
            fs: computeFileSystemSchema,
            shell: computeShellSchema,
            dispose: callableSchema,
        },
        exact,
    ),
);

/** Per-agent configuration read from `AgentConfig.modules.compute`. */
export const agentComputeConfigSchema = Type.Object(
    {
        cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
        providerId: Type.Optional(Type.Literal("host")),
    },
    exact,
);
export type AgentComputeConfig = Static<typeof agentComputeConfigSchema>;

const hostComputeProviderSchema = Type.Object(
    {
        id: Type.Literal("host"),
        create: Type.Function(
            [contextSchema, Type.Object({ cwd: Type.String({ minLength: 1 }) }, exact)],
            Type.Promise(hostComputeSchema),
        ),
    },
    exact,
);

/** The one global host provider used to create every agent's separate compute. */
export type HostComputeProvider = Pick<typeof hostComputeProvider, "id" | "create">;

export const computeModuleOptionsSchema = Type.Object(
    { provider: Type.Optional(hostComputeProviderSchema) },
    exact,
);
export type ComputeModuleOptions = Omit<Static<typeof computeModuleOptionsSchema>, "provider"> & {
    provider?: HostComputeProvider;
};

interface CachedCompute {
    readonly cwd: string;
    readonly compute: HostCompute;
}

/**
 * The shared compute module.
 *
 * One instance serves the whole AgentSystem. It reads each agent's immutable compute config,
 * creates one host compute for that agent through the global provider, and retains that exact
 * instance in memory for every module and tool serving the same agent.
 */
export class ComputeModule implements AgentModule {
    readonly name = "compute";
    readonly #provider: HostComputeProvider;
    readonly #computes = new Map<string, CachedCompute>();
    readonly #computeLocks: MapAsyncLock<string> = mapAsyncLock<string>();
    readonly #activeOperations = new Set<Promise<unknown>>();
    readonly #readLocks: MapAsyncLock<string> = mapAsyncLock<string>();
    /**
     * Read locks for the automatic permission reviewer's tools. The reviewer runs over a compute the
     * host owns for it — a different object entirely from the per-agent computes this module caches —
     * so its file-read bookkeeping must not share the main agents' lock map. Keying reviewer reads
     * here keeps a review's reads consistent among themselves without ever serializing against, or
     * being serialized by, a reviewed agent's own reads.
     */
    readonly #reviewerReadLocks: MapAsyncLock<string> = mapAsyncLock<string>();
    #closed = false;
    #disposePromise: Promise<void> | undefined;

    constructor(options: ComputeModuleOptions = {}) {
        const provider = options.provider ?? hostComputeProvider;
        const candidate = { provider: { id: provider.id, create: provider.create } };
        if (!Value.Check(computeModuleOptionsSchema, candidate)) {
            throw new Error("Compute module options are invalid.");
        }
        this.#provider = provider;
    }

    /** Resolve the exact compute cached for this agent, or no compute when none was configured. */
    async resolve(ctx: Context, agentId: string): Promise<HostCompute | undefined> {
        if (agentId.length === 0) throw new Error("Compute agent ID is invalid.");
        const raw = agentModuleConfig(ctx, this.name);
        if (raw === undefined) return undefined;
        if (!Value.Check(agentComputeConfigSchema, raw)) {
            throw new Error("Agent compute configuration is invalid.");
        }
        const config = raw as AgentComputeConfig;
        const providerId = config.providerId ?? "host";
        if (providerId !== this.#provider.id) {
            throw new Error(
                `Agent requested compute provider "${providerId}", but "${this.#provider.id}" is configured.`,
            );
        }

        return await this.#track(
            this.#computeLocks.runInLock(ctx, agentId, async (lockCtx) => {
                if (this.#closed) throw new Error("Compute module is closed.");
                const cached = this.#computes.get(agentId);
                if (cached !== undefined) {
                    if (cached.cwd !== config.cwd) {
                        throw new Error("An agent's cached compute configuration cannot change.");
                    }
                    return cached.compute;
                }

                const compute = await this.#create(lockCtx, config);
                if (this.#closed) {
                    await compute.dispose(lockCtx);
                    throw new Error("Compute module is closed.");
                }
                this.#computes.set(agentId, { cwd: config.cwd, compute });
                return compute;
            }),
        );
    }

    /** Commands currently running for one already-resolved agent compute. */
    runningCommands(agentId: string): readonly ComputeSessionActivity[] {
        const compute = this.#computes.get(agentId)?.compute;
        return compute?.shell.activeSessions?.() ?? [];
    }

    /** Read command output without advancing the model's output cursor. */
    async readCommand(
        agentId: string,
        commandId: number,
    ): Promise<ComputeSessionSnapshot | undefined> {
        const compute = this.#computes.get(agentId)?.compute;
        return await compute?.shell.readSession(commandId, { peek: true });
    }

    /** Stop a command by hand, returning whether it was still present. */
    async stopCommand(agentId: string, commandId: number): Promise<boolean> {
        const compute = this.#computes.get(agentId)?.compute;
        return compute === undefined
            ? false
            : (await compute.shell.killSession(commandId)) !== undefined;
    }

    /** Dispose every cached compute when the owning host shuts down. */
    async dispose(ctx: Context): Promise<void> {
        if (this.#disposePromise !== undefined) return await this.#disposePromise;
        this.#closed = true;
        this.#disposePromise = (async () => {
            await Promise.allSettled([...this.#activeOperations]);
            const cached = [...this.#computes.values()];
            this.#computes.clear();
            await Promise.all(cached.map(async ({ compute }) => await compute.dispose(ctx)));
        })();
        return await this.#disposePromise;
    }

    /**
     * Build the fixed, read-only tool array the automatic permission reviewer runs with, over a
     * compute the host owns for the reviewer.
     *
     * This is the reviewer counterpart to {@link tools}, but it is a pure builder rather than a
     * module hook: the reviewer lives in its own private agent system that this `ComputeModule`
     * never serves, so the host owns the reviewer's compute and hands it in here. The vendor is the
     * reviewer's own model route — a Claude review gets Claude's read-only tools, a Codex review
     * Codex's — chosen from `scope.agent.model` exactly as an ordinary agent's tools are chosen from
     * its model, so the reviewer sees the tool names it was trained on. Read bookkeeping uses the
     * reviewer's own read-lock map, under the reviewer's own agent ID and store, so a reviewer's file
     * reads stay consistent among themselves without touching any main agent's read log.
     */
    reviewerTools(scope: AgentModuleScope, compute: HostCompute): readonly AnyAgentTool[] {
        const reads = new FileReadLog(scope.kv, this.#reviewerReadLocks, scope.agent.id);
        return assembleReviewerTools(vendorFor(scope), compute, reads);
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const compute = await this.resolve(ctx, scope.agent.id);
            return compute === undefined ? "" : computeInstructionsForVendor(vendorFor(scope));
        },

        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const compute = await this.resolve(ctx, scope.agent.id);
            if (compute === undefined) return [];
            const reads = new FileReadLog(scope.kv, this.#readLocks, scope.agent.id);
            return assembleComputeTools(vendorFor(scope), compute, reads);
        },

        agentArchived: async (
            ctx: Context,
            _scope: AgentModuleSystemScope,
            agent: { readonly id: string },
        ): Promise<void> => {
            await this.#track(
                this.#computeLocks.runInLock(ctx, agent.id, async (lockCtx) => {
                    if (this.#closed) return;
                    const cached = this.#computes.get(agent.id);
                    if (cached === undefined) return;
                    this.#computes.delete(agent.id);
                    await cached.compute.dispose(lockCtx);
                }),
            );
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    async #track<Result>(operation: Promise<Result>): Promise<Result> {
        this.#activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            this.#activeOperations.delete(operation);
        }
    }

    async #create(ctx: Context, config: AgentComputeConfig): Promise<HostCompute> {
        const providerConfig: HostComputeConfig = { cwd: config.cwd };
        const compute = await this.#provider.create(ctx, providerConfig);
        const candidate = runtimeCompute(compute);
        if (!Value.Check(hostComputeSchema, candidate)) {
            if (typeof compute.dispose === "function") await compute.dispose(ctx);
            throw new Error("Host compute provider returned an invalid compute.");
        }
        if (
            compute.cwd !== config.cwd ||
            compute.fs.cwd !== config.cwd ||
            compute.shell.cwd !== config.cwd
        ) {
            await compute.dispose(ctx);
            throw new Error("Host compute provider returned mismatched working directories.");
        }
        return compute as HostCompute;
    }
}

/** Whose tools this agent's model was trained on, which is what it should be handed. */
function vendorFor(scope: AgentModuleScope): ComputeToolVendor {
    return computeToolVendor({
        model: scope.agent.model,
        ...(scope.agent.providerKind === undefined
            ? {}
            : { providerKind: scope.agent.providerKind }),
    });
}

function runtimeCompute(compute: Compute): unknown {
    return {
        id: compute.id,
        kind: compute.kind,
        cwd: compute.cwd,
        fs: compute.fs,
        shell: compute.shell,
        dispose: compute.dispose,
    };
}
