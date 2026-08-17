import { findLastAgentResponseText } from "./findLastAgentResponseText.js";
import { errorToMessage } from "../errorToMessage.js";
import { ensureLocalProtocolServer } from "../client/index.js";
import { loadConfig } from "../config/index.js";
import type {
    CreateSessionRequest,
    PermissionMode,
    ProtocolSession,
    ServiceTier,
    SessionEvent,
    StopReason,
} from "../protocol/index.js";
import { parsePermissionMode } from "./parsePermissionMode.js";
import type { ExecCommandOptions } from "./parseExecCommand.js";
import { readExecPrompt } from "./readExecPrompt.js";
import { RigUserError } from "../RigUserError.js";

export async function runExec(
    options: ExecCommandOptions,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    let debugDirectory: string | undefined;
    try {
        await run(options, environment, (directory) => {
            debugDirectory = directory;
        });
    } catch (error) {
        if (options.outputFormat === "text") throw error;
        const payload = {
            ...(debugDirectory === undefined ? {} : { debugDirectory }),
            error: errorToMessage(error),
            type: "error",
        };
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        process.exitCode = 1;
    }
}

async function run(
    options: ExecCommandOptions,
    environment: NodeJS.ProcessEnv,
    onDebugDirectory: (directory: string) => void,
): Promise<void> {
    const cwd = process.cwd();
    const prompt = await readExecPrompt(options.prompt);
    const loadedConfig = await loadConfig({ cwd, env: environment });
    const connection = await ensureLocalProtocolServer(
        options.outputFormat === "text"
            ? { onStatus: (message: string) => process.stderr.write(`${message}\n`) }
            : {},
    );

    const opened = await openSession(
        options,
        cwd,
        loadedConfig.config.defaults,
        connection.client,
        environment,
    );
    let session = opened.session;
    if (options.fork) {
        session = (await connection.client.forkSession(session.id)).session;
    }

    const sessionTerminal = await connection.client.connectSessionTerminal(session.id);
    try {
        const submitted = await connection.client.submitMessage(session.id, {
            ...(options.debug === true ? { debug: true } : {}),
            ...(opened.resumed && options.effort !== undefined ? { effort: options.effort } : {}),
            interactive: false,
            ...(opened.resumed && options.modelId !== undefined
                ? { modelId: options.modelId }
                : {}),
            ...(opened.resumed && options.permissionMode !== undefined
                ? { permissionMode: options.permissionMode }
                : {}),
            ...(opened.resumed && options.providerId !== undefined
                ? { providerId: options.providerId }
                : {}),
            text: prompt,
        });
        if (submitted.debugDirectory !== undefined) onDebugDirectory(submitted.debugDirectory);
        if (options.outputFormat === "text" && submitted.debugDirectory !== undefined) {
            process.stderr.write(`Debug log: ${submitted.debugDirectory}\n`);
        }
        const controller = new AbortController();
        let failure: string | undefined;
        let stopReason: StopReason | undefined;
        const abort = () => {
            stopReason = "aborted";
            void connection.client.abort(session.id);
            controller.abort();
        };
        process.once("SIGINT", abort);
        try {
            await connection.client.watchSessionEvents({
                after: submitted.eventId,
                sessionId: session.id,
                signal: controller.signal,
                onEvent(event) {
                    if (options.outputFormat === "stream-json") {
                        process.stdout.write(`${JSON.stringify({ event, type: "event" })}\n`);
                    }
                    if (event.type === "user_input_requested") {
                        failure = "The agent requested interactive input during a headless run.";
                        void connection.client.abort(session.id);
                        controller.abort();
                        return;
                    }
                    if (!belongsToRun(event, submitted.runId)) return;
                    if (event.type === "run_error") {
                        failure = event.data.errorMessage;
                        controller.abort();
                    } else if (event.type === "run_finished") {
                        stopReason = event.data.stopReason;
                        controller.abort();
                    }
                },
            });
        } finally {
            process.off("SIGINT", abort);
        }

        const completed = (await connection.client.getSession(session.id)).session;
        const response = findLastAgentResponseText(completed.snapshot.messages) ?? "";
        if (failure !== undefined) {
            emitFailure(
                options.outputFormat,
                failure,
                completed.id,
                submitted.runId,
                submitted.debugDirectory,
            );
            process.exitCode = 1;
            return;
        }

        const result = {
            ...(submitted.debugDirectory === undefined
                ? {}
                : { debugDirectory: submitted.debugDirectory }),
            response,
            runId: submitted.runId,
            sessionId: completed.id,
            stopReason: stopReason ?? "error",
            type: "result",
        };
        if (options.outputFormat === "text") {
            process.stdout.write(
                response.length === 0 || response.endsWith("\n") ? response : `${response}\n`,
            );
        } else {
            process.stdout.write(`${JSON.stringify(result)}\n`);
        }
        if (result.stopReason === "error" || result.stopReason === "aborted") process.exitCode = 1;
    } finally {
        await sessionTerminal.close().catch(() => undefined);
    }
}

async function openSession(
    options: ExecCommandOptions,
    cwd: string,
    defaults: {
        effort?: string;
        instructions?: string;
        modelId: string;
        permissionMode: PermissionMode;
        providerId?: string;
        serviceTier?: ServiceTier;
    },
    client: Awaited<ReturnType<typeof ensureLocalProtocolServer>>["client"],
    environment: NodeJS.ProcessEnv,
): Promise<{ readonly resumed: boolean; readonly session: ProtocolSession }> {
    let sessionId = options.resumeSessionId;
    if (options.last) {
        const listed = await client.listSessions();
        sessionId = listed.sessions.find((session) => session.cwd === cwd)?.id;
        if (sessionId === undefined) {
            throw new RigUserError("Rig has no saved sessions in this directory.", {
                hint: "Pass --resume <session-id> to name one explicitly.",
            });
        }
    }
    if (sessionId !== undefined) {
        return { resumed: true, session: (await client.getSession(sessionId)).session };
    }

    const request: CreateSessionRequest = {
        cwd,
        modelId: options.modelId ?? environment.RIG_MODEL ?? defaults.modelId,
        // Read the same way the model and provider are. An exec run that asked for a narrower
        // mode and silently got the default would be given reach it was told it would not have.
        permissionMode:
            options.permissionMode ??
            (environment.RIG_PERMISSION_MODE === undefined
                ? undefined
                : parsePermissionMode(environment.RIG_PERMISSION_MODE)) ??
            defaults.permissionMode,
    };
    const providerId = options.providerId ?? environment.RIG_PROVIDER ?? defaults.providerId;
    const effort = options.effort ?? environment.RIG_EFFORT ?? defaults.effort;
    const instructions = defaults.instructions;
    const serviceTier = defaults.serviceTier;
    if (providerId !== undefined) request.providerId = providerId;
    if (effort !== undefined) request.effort = effort;
    if (instructions !== undefined) request.instructions = instructions;
    if (serviceTier !== undefined) request.serviceTier = serviceTier;
    return { resumed: false, session: (await client.createSession(request)).session };
}

function belongsToRun(event: SessionEvent, runId: string): boolean {
    return "runId" in event.data && event.data.runId === runId;
}

function emitFailure(
    outputFormat: ExecCommandOptions["outputFormat"],
    error: string,
    sessionId: string,
    runId: string,
    debugDirectory?: string,
): void {
    if (outputFormat === "text") {
        process.stderr.write(`${error}\n`);
        return;
    }
    process.stdout.write(
        `${JSON.stringify({ ...(debugDirectory === undefined ? {} : { debugDirectory }), error, runId, sessionId, type: "error" })}\n`,
    );
}
