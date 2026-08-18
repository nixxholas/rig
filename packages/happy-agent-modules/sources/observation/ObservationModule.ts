import { mkdir } from "node:fs/promises";

import type {
    AgentBaseCompaction,
    AgentBaseInference,
    AgentBaseLoop,
    AgentBaseSettlement,
    AgentBaseToolOutcome,
    AgentBaseTurn,
    AgentBaseTurnStart,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
} from "@slopus/happy-agent-base";
import {
    withLogContext,
    withLogger,
    withTracer,
    type Context,
    type Logger,
    type RootContext,
} from "@steve.kite/stdlib";

import type { HappyAgentConfiguration } from "../config/ConfigModule.js";
import type { HistoryMessage } from "../history/HistoryMessage.js";
import {
    MAX_OBSERVATION_FILE_BYTES,
    MAX_OBSERVATION_PENDING_BYTES,
    resolveObservationSettings,
    type ObservationSettings,
} from "./ObservationSettings.js";
import { HistoryDump } from "./impl/HistoryDump.js";
import { RotatingFileWriter } from "./impl/RotatingFileWriter.js";
import { createObservationLogger } from "./impl/createObservationLogger.js";
import {
    startObservationTracing,
    type ObservationTracing,
} from "./impl/startObservationTracing.js";

/** What the observation module needs to know before it can watch anything. */
export interface ObservationModuleOptions {
    /** The resolved configuration, which supplies both the settings and the paths. */
    readonly configuration: HappyAgentConfiguration;
    /** The environment whose `HAPPY_OBSERVATION_*` overrides apply. Defaults to the process's. */
    readonly environment?: NodeJS.ProcessEnv;
    /** The deployment spans are labeled with, such as `production` or `local-development`. */
    readonly deployment?: string;
}

/**
 * What the agent records about itself: logs, traces, and a readable copy of its history.
 *
 * Three separate audiences, one module, because all three answer the same question — what was this
 * agent actually doing — and all three need the same thing from the host: a place on disk, a
 * lifetime, and somewhere to be installed before any work starts.
 *
 * Logging and tracing both work by installation rather than by call. `ctx.log` and `ctx.span` exist
 * on every context and do nothing at all until a logger and a tracer are installed on the root the
 * rest are derived from; {@link install} is where that happens. So the spans that describe the
 * agent's loop, turns, inferences, and tool calls are opened by the agent runtime itself, around
 * the work they measure, and this module only decides whether anything is listening.
 *
 * The history dump is the odd one out: it is not telemetry but a plain file per agent, one JSON
 * object per record, appended as the durable history commits. It is what a person tails.
 */
export class ObservationModule implements AgentModule {
    readonly name = "observation";

    readonly #settings: ObservationSettings;
    readonly #logWriter: RotatingFileWriter | undefined;
    readonly #logger: Logger | undefined;
    readonly #tracing: ObservationTracing | undefined;
    readonly #historyDump: HistoryDump | undefined;
    #closed = false;

    private constructor(parts: {
        readonly settings: ObservationSettings;
        readonly logWriter: RotatingFileWriter | undefined;
        readonly tracing: ObservationTracing | undefined;
        readonly historyDump: HistoryDump | undefined;
    }) {
        this.#settings = parts.settings;
        this.#logWriter = parts.logWriter;
        this.#logger =
            parts.logWriter === undefined
                ? undefined
                : createObservationLogger(parts.logWriter, parts.settings.logLevel);
        this.#tracing = parts.tracing;
        this.#historyDump = parts.historyDump;
    }

    /**
     * Open everything the configured settings ask for, and nothing they do not.
     *
     * This runs before the agent system exists, because the logger it produces has to be on the
     * context that system is created with.
     */
    static async start(options: ObservationModuleOptions): Promise<ObservationModule> {
        const { paths, values } = options.configuration;
        const settings = resolveObservationSettings(values.observation, options.environment);
        const logWriter = settings.logs
            ? await RotatingFileWriter.open({
                  maxBytes: MAX_OBSERVATION_FILE_BYTES,
                  maxPendingBytes: MAX_OBSERVATION_PENDING_BYTES,
                  path: paths.logPath,
              })
            : undefined;
        let historyDump: HistoryDump | undefined;
        if (settings.historyDump) {
            await mkdir(paths.historyDumpHome, { recursive: true });
            historyDump = new HistoryDump(paths.historyDumpHome);
        }
        const tracing = settings.traces
            ? startObservationTracing({
                  deployment: options.deployment ?? "production",
                  endpoint: settings.tracesEndpoint,
                  version: options.configuration.version,
              })
            : undefined;
        return new ObservationModule({ historyDump, logWriter, settings, tracing });
    }

    /** The settings actually in force, after configuration and environment have both been read. */
    get settings(): ObservationSettings {
        return this.#settings;
    }

    /**
     * The application root every other lifetime should be derived from.
     *
     * Installing rather than mutating is the whole point: contexts are immutable, so the host takes
     * this one and uses it, and everything downstream inherits the logger and tracer by construction
     * instead of by looking anything up.
     */
    install(ctx: RootContext): RootContext {
        const logged = this.#logger === undefined ? ctx : withLogger(ctx, this.#logger);
        return this.#tracing === undefined
            ? logged
            : withTracer(logged, this.#tracing.contextTracer);
    }

    /**
     * The listener `HistoryModule` calls once each history append has committed.
     *
     * Pass it as that module's `onAppend`. It is deliberately a bound property rather than a
     * method, so the host can hand it over without binding it and without exposing this module.
     */
    readonly recordHistory = async (
        _ctx: Context,
        agentId: string,
        messages: readonly HistoryMessage[],
    ): Promise<void> => {
        await this.#historyDump?.record(agentId, messages);
    };

    /** Resolve once everything observed so far has reached its file. */
    async flush(): Promise<void> {
        await Promise.all([this.#historyDump?.flush(), this.#logWriter?.flush()]);
    }

    /**
     * Close every file and stop exporting.
     *
     * A collector that has gone away, or a disk that has filled, must not turn an otherwise clean
     * shutdown into a failure — so every part is settled and the first real failure is reported
     * only after all of them have had their chance to finish.
     */
    async close(_ctx?: Context): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        const outcomes = await Promise.allSettled([
            this.#historyDump?.close() ?? Promise.resolve(),
            this.#tracing?.shutdown() ?? Promise.resolve(),
        ]);
        // The log file closes last so anything the shutdown above logged is still written.
        const logOutcome = await Promise.allSettled([
            this.#logWriter?.close() ?? Promise.resolve(),
        ]);
        const failures = [...outcomes, ...logOutcome]
            .filter((outcome) => outcome.status === "rejected")
            .map((outcome) => outcome.reason);
        if (failures.length > 0) {
            throw new AggregateError(failures, "Observation did not shut down cleanly.");
        }
    }

    readonly #hooks: AgentModuleHooks = {
        beforeAgentLoop: (ctx: Context, scope: AgentModuleScope, loop: AgentBaseLoop): void => {
            withLogContext(ctx, { agentId: scope.agent.id, loopId: loop.loopId }).log.info(
                "The agent started a run.",
            );
        },

        beforeTurn: (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurnStart,
        ): undefined => {
            withLogContext(ctx, {
                agentId: scope.agent.id,
                turnId: turn.turnId,
                ...(turn.contextTokens === undefined ? {} : { contextTokens: turn.contextTokens }),
            }).log.debug("The agent started a turn.");
            return undefined;
        },

        afterTurn: (ctx: Context, scope: AgentModuleScope, turn: AgentBaseTurn): undefined => {
            withLogContext(ctx, {
                agentId: scope.agent.id,
                turnId: turn.turnId,
            }).log.debug(
                turn.aborted ? "The agent's turn was cancelled." : "The agent finished a turn.",
            );
            return undefined;
        },

        afterInference: (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): void => {
            const inferenceCtx = withLogContext(ctx, {
                agentId: scope.agent.id,
                inferenceId: inference.inferenceId,
                ...(inference.state === undefined ? {} : { state: inference.state }),
                ...(inference.tokens === undefined
                    ? {}
                    : {
                          inputTokens: inference.tokens.input,
                          outputTokens: inference.tokens.output,
                      }),
            });
            if (inference.errorMessage === undefined) {
                inferenceCtx.log.debug("The model answered.");
                return;
            }
            inferenceCtx.log.warn("The model did not answer:", inference.errorMessage);
        },

        afterToolCall: (
            ctx: Context,
            scope: AgentModuleScope,
            outcome: AgentBaseToolOutcome,
        ): void => {
            const callCtx = withLogContext(ctx, {
                agentId: scope.agent.id,
                callId: outcome.callId,
                tool: outcome.tool.name,
            });
            callCtx.log.debug(
                outcome.isError
                    ? `The ${outcome.tool.name} tool reported a failure.`
                    : `The ${outcome.tool.name} tool finished.`,
            );
        },

        afterCompaction: (
            ctx: Context,
            scope: AgentModuleScope,
            compaction: AgentBaseCompaction,
        ): void => {
            withLogContext(ctx, {
                agentId: scope.agent.id,
                compactionId: compaction.compactionId,
                outcome: compaction.result.status,
            }).log.info(COMPACTION_MESSAGES[compaction.result.status]);
        },

        afterAgentSettled: (
            ctx: Context,
            scope: AgentModuleScope,
            settlement: AgentBaseSettlement,
        ): void => {
            withLogContext(ctx, {
                agentId: scope.agent.id,
                loopId: settlement.loopId,
                settlementId: settlement.settlementId,
            }).log.info("The agent has nothing left to do.");
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

/** What each compaction outcome is called, in the words a person reading the log would use. */
const COMPACTION_MESSAGES: Readonly<Record<AgentBaseCompaction["result"]["status"], string>> = {
    cancelled: "Compacting the conversation was cancelled.",
    completed: "The conversation was compacted.",
    failed: "Compacting the conversation failed.",
};
