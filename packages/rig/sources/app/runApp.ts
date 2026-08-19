import { basename } from "node:path";

import { TUI } from "@earendil-works/pi-tui";
import type { HappyAgentEvent, Question } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import {
    ensureLocalProtocolServer,
    ensureWorkspaceForCwd,
    HappyAgentEventHub,
    RemoteAgent,
} from "../client/index.js";
import { loadConfig, updateRuntimePreferences } from "../config/index.js";
import {
    getDebugRootDirectory,
    getNodeInspectorUrl,
    openNodeInspector,
    registerRigDebugRoot,
} from "../debug/index.js";
import { NativeProcessManager } from "../processes/index.js";
import type { PermissionMode, UserInputRequest } from "../protocol/index.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { reportCliFailure } from "../reportCliFailure.js";
import { CodingAssistantApp, type AppExitReason } from "./CodingAssistantApp.js";
import { createSerialTaskQueue } from "./createSerialTaskQueue.js";
import { createStopOnceHandler } from "./createStopOnceHandler.js";
import { humanizePermissionMode } from "./humanizePermissionMode.js";
import { humanizeProviderId } from "./humanizeProviderId.js";
import { humanizeReasoningLevel } from "./humanizeReasoningLevel.js";
import { installResumeInstructions } from "./installResumeInstructions.js";
import { installTerminalCrashCleanup } from "./installTerminalCrashCleanup.js";
import {
    resolveStartupSessionId,
    type StartupSessionSelection,
} from "./resolveStartupSessionId.js";
import { resolveTerminalTheme } from "./resolveTerminalTheme.js";
import { RigTerminal } from "./RigTerminal.js";
import { StartupStatusApp } from "./StartupStatusApp.js";

const INITIAL_TUI_MESSAGE_LIMIT = 30;

export interface RunAppOptions {
    compactCompletedTurns?: boolean;
    cwd?: string;
    debug?: boolean;
    effort?: string;
    instructions?: string;
    modelId?: string;
    providerId?: string;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    sessionSelection?: StartupSessionSelection;
    showReasoning?: boolean;
    showUsage?: boolean;
}

export type RunAppResult = { action: "exit" } | { action: "reload"; sessionId: string };

export async function runApp(ctx: Context, options: RunAppOptions = {}): Promise<RunAppResult> {
    const requestedCwd = options.cwd ?? process.cwd();
    const loadedConfig = await loadConfig({ cwd: requestedCwd });
    let compactCompletedTurns =
        options.compactCompletedTurns ?? loadedConfig.config.settings.compactCompletedTurns;
    let completionChime = loadedConfig.config.settings.completionChime;
    let showReasoning = options.showReasoning ?? loadedConfig.config.settings.showReasoning;
    let showUsage = options.showUsage ?? loadedConfig.config.settings.showUsage;
    const enqueueRuntimeConfigWrite = createSerialTaskQueue();
    const startupTheme = resolveTerminalTheme(loadedConfig.config.theme);
    const runtimeTheme = loadedConfig.sources.runtime.values.theme;

    const terminal = new RigTerminal();
    terminal.setTitle(`Rig - ${sanitizeTerminalTitle(basename(requestedCwd))}`);
    const tui = new TUI(terminal, false);
    const startup = new StartupStatusApp({
        cwd: requestedCwd,
        rows: () => terminal.rows,
        theme: startupTheme,
        tui,
        version: readPackageVersion(),
    });
    const terminalCrashCleanup = installTerminalCrashCleanup({ terminal, tui });
    let terminalAppearance: Promise<
        [
            Awaited<ReturnType<TUI["queryTerminalBackgroundColor"]>>,
            Awaited<ReturnType<TUI["queryTerminalColorScheme"]>>,
        ]
    >;
    try {
        startup.start();
        tui.setTerminalColorSchemeNotifications(true);
        terminal.write("\x1b[?1004h");
        terminalAppearance = Promise.all([
            tui.queryTerminalBackgroundColor({ timeoutMs: 250 }),
            tui.queryTerminalColorScheme({ timeoutMs: 250 }),
        ]);
    } catch (error) {
        await restoreAfterFailure(startup, terminalCrashCleanup);
        throw error;
    }

    let exitReason: AppExitReason = "exit";
    const opened = await (async () => {
        try {
            const localServer = await ensureLocalProtocolServer({
                confirmRestart: (request) => startup.confirmDaemonRestart(request),
                onStatus: (message) => startup.setStatus(message),
            });
            let agentId = options.resumeSessionId;
            if (options.sessionSelection !== undefined) {
                agentId = await resolveStartupSessionId({
                    client: localServer.client,
                    cwd: requestedCwd,
                    selection: options.sessionSelection,
                    startup,
                });
                if (agentId === undefined) return undefined;
            }

            startup.setStatus("Opening agent.");
            const resumed = agentId !== undefined;
            const agentResponse =
                agentId === undefined
                    ? await localServer.client.createAgent({
                          workspaceId: (
                              await ensureWorkspaceForCwd(localServer.client, requestedCwd)
                          ).id,
                      })
                    : await localServer.client.getAgent(agentId);
            if (agentResponse.agent.parentAgentId !== null) {
                throw new Error(
                    "Subagents are driven by their parent and cannot be opened as an interactive Rig agent.",
                );
            }
            const eventCursor = (await localServer.client.getEvents({ limit: 1 })).latestCursor;
            const [configResponse, history, pendingQuestion, workspaceResponse] = await Promise.all(
                [
                    localServer.client.getConfig(),
                    localServer.client.getMessages(agentResponse.agent.id, {
                        limit: INITIAL_TUI_MESSAGE_LIMIT,
                        omitToolData: true,
                    }),
                    localServer.client.getPendingQuestion(agentResponse.agent.id),
                    localServer.client.getWorkspace(agentResponse.agent.workspaceId),
                ],
            );
            if (agentResponse.agent.unread !== null) {
                await localServer.client
                    .markAgentRead(agentResponse.agent.id)
                    .catch(() => undefined);
            }
            return {
                agent: agentResponse.agent,
                config: configResponse.config,
                eventCursor,
                history,
                localServer,
                pendingQuestion: pendingQuestion.question,
                resumed,
                workspace: workspaceResponse.workspace,
            };
        } catch (error) {
            await restoreAfterFailure(startup, terminalCrashCleanup);
            throw error;
        }
    })();
    if (opened === undefined) {
        startup.stop();
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        return { action: "exit" };
    }

    const resumeCommand = `rig resume ${opened.agent.id}`;
    const resumeInstructions = installResumeInstructions({
        resumeCommand,
        sessionId: opened.agent.id,
    });
    try {
        const processManager = new NativeProcessManager();
        const [terminalBackground, terminalColorScheme] = await terminalAppearance;
        const theme = resolveTerminalTheme(
            loadedConfig.config.theme,
            terminalBackground ?? terminalColorSchemeBackground(terminalColorScheme),
        );
        const workspaceCwd =
            opened.workspace.compute.type === "host" ? opened.workspace.compute.path : requestedCwd;
        if (opened.agent.title !== null) {
            terminal.setTitle(`Rig - ${sanitizeTerminalTitle(opened.agent.title)}`);
        }

        const events = new HappyAgentEventHub(opened.localServer.client, opened.eventCursor);
        events.start();
        const agent = new RemoteAgent({
            agent: opened.agent,
            client: opened.localServer.client,
            config: opened.config,
            events,
            history: opened.history,
        });
        const providerId =
            options.providerId ??
            loadedConfig.config.defaults.providerId ??
            opened.config.defaults.providerId;
        const modelId =
            options.modelId ??
            loadedConfig.config.defaults.modelId ??
            opened.config.defaults.modelId;
        const effort =
            options.effort ?? loadedConfig.config.defaults.effort ?? opened.config.defaults.effort;
        agent.setModel(modelId, effort, providerId);
        agent.setPermissionMode(
            options.permissionMode ??
                loadedConfig.config.defaults.permissionMode ??
                opened.config.defaults.permissionMode,
        );
        if (loadedConfig.config.defaults.serviceTier !== undefined) {
            agent.setServiceTier(loadedConfig.config.defaults.serviceTier);
        }

        const version = readPackageVersion();
        const tuiInspectorUrl = getNodeInspectorUrl();
        const app = new CodingAssistantApp({
            agent,
            compactCompletedTurns,
            completionChime,
            ctx,
            cwd: workspaceCwd,
            debugInfo: {
                daemonLogPath: opened.localServer.paths.logPath,
                sessionId: opened.agent.id,
                startInspectors: async () => {
                    const server = await opened.localServer.client.startInspector();
                    return {
                        serverInspectorUrl: server.inspectorUrl,
                        tuiInspectorUrl: openNodeInspector(),
                    };
                },
                stateDirectory: opened.localServer.paths.directory,
                tuiStderrIsTTY: process.stderr.isTTY === true,
                ...(tuiInspectorUrl === undefined ? {} : { tuiInspectorUrl }),
            },
            initialMessages: agent.snapshot().messages,
            ...(opened.pendingQuestion === null
                ? {}
                : { initialUserInputs: [toUserInputRequest(opened.pendingQuestion)] }),
            ...(options.debug === true
                ? {
                      initialNotices: [
                          {
                              text: `Each request may write private JSON records to ${getDebugRootDirectory(workspaceCwd)}. These files can include prompts, model responses, tool arguments, and tool results.`,
                              title: "Debug logging enabled",
                          },
                      ],
                  }
                : {}),
            onDefaultModelChange: (preference) =>
                enqueueRuntimeConfigWrite(() =>
                    updateRuntimePreferences(loadedConfig.paths.runtime, {
                        defaults: {
                            effort: preference.effort,
                            modelId: preference.modelId,
                            permissionMode: agent.permissionMode,
                            providerId: preference.providerId,
                            serviceTier: preference.serviceTier,
                        },
                        settings: {
                            compactCompletedTurns,
                            completionChime,
                            showReasoning,
                            showUsage,
                        },
                        ...(runtimeTheme === undefined ? {} : { theme: runtimeTheme }),
                    }),
                ),
            onSettingsChange: async (settings) => {
                compactCompletedTurns = settings.compactCompletedTurns;
                completionChime = settings.completionChime;
                showReasoning = settings.showReasoning;
                showUsage = settings.showUsage;
                await enqueueRuntimeConfigWrite(() =>
                    updateRuntimePreferences(loadedConfig.paths.runtime, {
                        defaults: {
                            effort: agent.snapshot().effort ?? agent.model.defaultThinkingLevel,
                            modelId: agent.model.id,
                            permissionMode: agent.permissionMode,
                            providerId: agent.provider.id,
                            serviceTier: agent.confirmedServiceTier ?? null,
                        },
                        settings,
                        ...(runtimeTheme === undefined ? {} : { theme: runtimeTheme }),
                    }),
                );
            },
            processManager,
            respondUserInput: (questionId, response) =>
                opened.localServer.client
                    .answerQuestion(opened.agent.id, questionId, {
                        answers: Object.fromEntries(
                            Object.entries(response.answers).map(([id, values]) => [
                                id,
                                [...values],
                            ]),
                        ),
                    })
                    .then(() => undefined),
            searchFiles: (query) =>
                opened.localServer.client
                    .searchFiles(opened.workspace.id, { query })
                    .then((response) => response.files),
            sessionBacked: true,
            showReasoning,
            showUsage,
            startupStatus: {
                access: humanizePermissionMode(agent.permissionMode),
                environment: opened.workspace.compute.type === "host" ? "Local" : "Docker",
                fast: agent.confirmedServiceTier !== undefined,
                model: agent.model.name,
                provider: humanizeProviderId(agent.provider.id),
                reasoning: humanizeReasoningLevel(
                    agent.snapshot().effort ?? agent.model.defaultThinkingLevel,
                ),
                session: opened.resumed ? "Resumed" : "New session",
                version,
                workspace: workspaceCwd,
            },
            theme,
            tui,
            version,
        });

        let terminalThemeRefresh = 0;
        const stopWatchingTerminalTheme = tui.onTerminalColorSchemeChange((colorScheme) => {
            const refresh = ++terminalThemeRefresh;
            void tui.queryTerminalBackgroundColor({ timeoutMs: 250 }).then((background) => {
                if (refresh !== terminalThemeRefresh) return;
                app.setTheme(
                    resolveTerminalTheme(
                        loadedConfig.config.theme,
                        background ?? terminalColorSchemeBackground(colorScheme),
                    ),
                );
            });
        });
        startup.stop();

        const followController = new AbortController();
        registerRigDebugRoot({
            agent,
            app,
            connection: opened.localServer,
            eventFollowerController: followController,
            kind: "tui",
            sessionId: opened.agent.id,
            terminal,
            tui,
        });
        void followAgentEvents({
            after: opened.agent.lastCursor,
            agent,
            app,
            chime: () => {
                if (completionChime) terminal.write("\x07");
            },
            events,
            signal: followController.signal,
            terminal,
        }).catch((error: unknown) => {
            if (!followController.signal.aborted) reportCliFailure(error);
        });

        const requestStop = createStopOnceHandler(
            () => app.stop(),
            (error) => reportCliFailure(error),
        );
        const stop = () => void requestStop();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        process.on("SIGHUP", stop);

        let appExitedNormally = false;
        try {
            app.start({ tuiAlreadyStarted: true });
            exitReason = await app.waitForExit();
            appExitedNormally = true;
        } finally {
            if (!appExitedNormally) await terminalCrashCleanup.restoreAndDrain();
            terminalCrashCleanup.uninstall();
            stopWatchingTerminalTheme();
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            process.off("SIGHUP", stop);
            followController.abort();
            await events.close();
            terminal.write("\x1b[?1004l");
            await processManager.killAll(ctx, { forceAfterMs: 500, includeDetached: true });
            if (exitReason === "reload") resumeInstructions.suppress();
            else resumeInstructions.report();
        }
    } catch (error) {
        await terminalCrashCleanup.restoreAndDrain();
        terminalCrashCleanup.uninstall();
        throw error;
    }
    return exitReason === "reload"
        ? { action: "reload", sessionId: opened.agent.id }
        : { action: "exit" };
}

async function followAgentEvents(options: {
    after: string;
    agent: RemoteAgent;
    app: CodingAssistantApp;
    chime: () => void;
    events: HappyAgentEventHub;
    signal: AbortSignal;
    terminal: RigTerminal;
}): Promise<void> {
    await options.events.follow({
        after: options.after,
        signal: options.signal,
        onGap: async () => {
            options.app.applyAgentSnapshot(await options.agent.resync());
        },
        onEvent: (event) => {
            const message = options.agent.applyEvent(event);
            if (message !== undefined) options.app.applyMessage(message);
            const loopEvent = options.agent.applyLoopEvent(event);
            if (loopEvent !== undefined) options.app.applyAgentLoopEvent(loopEvent);
            if (event.type === "agent.updated" && event.payload.agentId === options.agent.id) {
                const title = event.payload.changes.title;
                if (typeof title === "string") {
                    options.terminal.setTitle(`Rig - ${sanitizeTerminalTitle(title)}`);
                }
            } else if (
                event.type === "question.created" &&
                event.payload.question.agentId === options.agent.id
            ) {
                options.app.applyUserInputRequest(toUserInputRequest(event.payload.question));
                options.chime();
            } else if (
                event.type === "question.updated" &&
                questionBelongsToAgent(event, options.agent.id) &&
                event.payload.changes.status !== "pending"
            ) {
                options.app.resolveUserInputRequest(event.payload.questionId);
            } else if (
                event.type === "run.finished" &&
                event.payload.agentId === options.agent.id &&
                event.payload.run.reason !== "abort"
            ) {
                options.chime();
            }
            return false;
        },
    });
}

function questionBelongsToAgent(
    event: Extract<HappyAgentEvent, { type: "question.updated" }>,
    agentId: string,
): boolean {
    const changes = event.payload.changes;
    return changes.agentId === undefined || changes.agentId === agentId;
}

function toUserInputRequest(question: Question): UserInputRequest {
    return {
        ...(question.autoResolveAt === null
            ? {}
            : { autoResolutionMs: Math.max(0, question.autoResolveAt - Date.now()) }),
        questions: question.questions.map((prompt) => ({
            header: prompt.header,
            id: prompt.id,
            multiSelect: prompt.multiSelect,
            options: prompt.options,
            question: prompt.question,
        })),
        requestId: question.id,
    };
}

async function restoreAfterFailure(
    startup: StartupStatusApp,
    cleanup: ReturnType<typeof installTerminalCrashCleanup>,
): Promise<void> {
    try {
        startup.stop();
    } catch {
        // Preserve the original failure while restoring the terminal.
    }
    await cleanup.restoreAndDrain();
    cleanup.uninstall();
}

function terminalColorSchemeBackground(
    colorScheme: "dark" | "light" | undefined,
): { r: number; g: number; b: number } | undefined {
    if (colorScheme === undefined) return undefined;
    return colorScheme === "light" ? { r: 0xff, g: 0xff, b: 0xff } : { r: 0x0d, g: 0x0d, b: 0x0d };
}

function sanitizeTerminalTitle(value: string): string {
    return [...value]
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint > 31 && codePoint !== 127;
        })
        .join("");
}
