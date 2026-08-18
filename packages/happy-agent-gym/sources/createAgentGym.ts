import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { AgentModel, AgentPermissionMode } from "@slopus/happy-agent-base";
// The agent is started from its own sources rather than its published build, so a gym always
// exercises the code in this checkout and a failure points at the file that caused it.
import { startHappyAgentDaemon, type HappyAgentDaemon } from "../../happy-agent/sources/main.js";
import type {
    HappyAgentModules,
    StartedHappyAgent,
} from "../../happy-agent/sources/start/startHappyAgent.js";
import type { AgentEvent } from "@slopus/happy-agent-modules";

import { createGymCompute } from "./createGymCompute.js";
import {
    createGymHome,
    resolveFixturePath,
    type GymHome,
    type GymHomeOptions,
} from "./createGymHome.js";
import { GymEventStream, type GymEventStreamOptions } from "./GymEventStream.js";
import { GymHttpClient } from "./GymHttpClient.js";
import {
    createScriptedInference,
    GYM_MODEL_ID,
    GYM_PROVIDER_ID,
    type GymCompactionHandler,
    type GymInference,
    type GymInferenceLog,
} from "./scriptedInference.js";

export interface AgentGymOptions extends GymHomeOptions {
    /** The turns the scripted model answers with, or a handler that answers each request. */
    readonly inference?: GymInference;
    /** How a scripted compaction answers. Defaults to a completed, empty compaction. */
    readonly compaction?: GymCompactionHandler;
    /** Replaces the two models a gym serves. */
    readonly models?: readonly AgentModel[];
    /** The default budget for every `waitFor` in this gym. */
    readonly timeoutMs?: number;
    /** The version the daemon reports. */
    readonly version?: string;
}

/** Everything a request must name, so a test never has to repeat it. */
export interface GymSelection {
    readonly effort: string;
    readonly modelId: string;
    readonly providerId: string;
    readonly serviceTier: null;
}

/** A session as the daemon reports it. */
export interface GymSessionRecord {
    readonly id: string;
    readonly [key: string]: unknown;
}

/** What the daemon answers when it takes a message. */
export interface GymAcceptance {
    readonly accepted: string;
    readonly delivery: string;
    readonly id: string;
    /** The run this message belongs to, which is what a completion is waited for by. */
    readonly runId: string;
    readonly sessionId: string;
    readonly [key: string]: unknown;
}

export interface GymSendOptions {
    /** The session to send to. Defaults to the installation's root chat. */
    readonly sessionId?: string;
    /** Whether the daemon answers only once the message is durably recorded. Defaults to true. */
    readonly await?: boolean;
    /**
     * Whether to return only after the run this message started has settled. Defaults to true for
     * a send and false for steering, which by definition joins a run that is already going.
     */
    readonly wait?: boolean;
    readonly effort?: string;
    readonly modelId?: string;
    readonly providerId?: string;
    readonly permissionMode?: AgentPermissionMode;
    readonly mutationId?: string;
}

export interface GymCreateSessionOptions {
    /** The folder the session works in. Defaults to the gym workspace. */
    readonly cwd?: string;
    readonly id?: string;
    readonly effort?: string;
    readonly modelId?: string;
    readonly providerId?: string;
    readonly permissionMode?: AgentPermissionMode;
}

/**
 * One complete, isolated Happy agent.
 *
 * The daemon, its socket, both databases, every module, the agent loop, the tools and the
 * permission reviewer are the real product. Only two things are substituted: the model is
 * scripted, and the machine is a just-bash shell over the gym's own workspace folder, so a
 * scenario never starts a process on the computer running the test.
 */
export interface AgentGym {
    /** Happy's private root for this gym. */
    readonly happyHome: string;
    /** The agent's working directory, which is also where fixtures were written. */
    readonly workspacePath: string;
    readonly socketPath: string;
    readonly token: string;
    /** The daemon's `/v0` API over its real Unix socket. Prefer this in scenarios. */
    readonly http: GymHttpClient;
    /** What the scripted model was asked, and what it could not answer. */
    readonly inference: GymInferenceLog;
    readonly daemon: HappyAgentDaemon;
    readonly agent: StartedHappyAgent;
    readonly modules: HappyAgentModules;
    /** The chat this installation opens with, which is also the root agent's id. */
    readonly rootSessionId: string;
    /** The provider, model, effort and tier every gym request names by default. */
    readonly selection: GymSelection;
    /** Errors the HTTP server reported outside a response. A healthy scenario leaves this empty. */
    readonly errors: readonly unknown[];

    /** Send a user message and, by default, wait for the run it starts to settle. */
    send(text: string, options?: GymSendOptions): Promise<GymAcceptance>;
    /** Queue a message for the current turn's boundary. */
    steer(text: string, options?: GymSendOptions): Promise<GymAcceptance>;
    /** Wait for one run to settle, and answer with the durable event that says how it ended. */
    waitForRun(runId: string, timeoutMs?: number): Promise<AgentEvent>;
    /** Cancel the active turn. */
    abort(sessionId?: string): Promise<unknown>;
    /** Compact a conversation. */
    compact(sessionId?: string): Promise<unknown>;
    /** Create another chat. */
    createSession(options?: GymCreateSessionOptions): Promise<GymSessionRecord>;
    /** Every session the daemon lists. */
    listSessions(): Promise<readonly GymSessionRecord[]>;
    /** One session, including its recent messages. */
    getSession(sessionId?: string): Promise<GymSessionRecord>;
    /** The client-facing event projection for one session. */
    sessionEvents(sessionId?: string): Promise<readonly Record<string, unknown>[]>;

    /** Every durable event the installation has recorded, oldest first. */
    events(): Promise<readonly AgentEvent[]>;
    /** The first durable event matching `predicate`, waiting for it to arrive. */
    waitForEvent(
        predicate: (event: AgentEvent) => boolean,
        description?: string,
        timeoutMs?: number,
    ): Promise<AgentEvent>;
    /**
     * Wait for any condition, polling instead of sleeping.
     *
     * `check` returns the value the caller wanted, or `undefined` while it is not there yet.
     */
    waitUntil<Result>(
        check: () => Result | undefined | Promise<Result | undefined>,
        description?: string | (() => string),
        timeoutMs?: number,
    ): Promise<Result>;
    /** Open a live Server-Sent Events subscription, such as `/v0/events/live`. */
    stream(path?: string, options?: GymEventStreamOptions): GymEventStream;

    /** Read a file from the workspace as text. */
    readFile(path: string): Promise<string>;
    /** Write a file into the workspace. */
    writeFile(path: string, content: string): Promise<void>;
    /** Whether a workspace path exists. */
    exists(path: string): Promise<boolean>;
    /** Every file in the workspace, relative to it and sorted. */
    listFiles(): Promise<readonly string[]>;

    /** Stop the daemon and start it again on the same folder, the way a restart really happens. */
    restart(): Promise<void>;
    /** Stop everything and delete the folder. Always call this, including when a test fails. */
    dispose(): Promise<void>;
}

/** Start one gym. Every call is completely isolated from every other. */
export async function createAgentGym(options: AgentGymOptions = {}): Promise<AgentGym> {
    const home = await createGymHome(options);
    try {
        const gym = new AgentGymInstance(home, options);
        await gym.start();
        return gym;
    } catch (error) {
        await home.remove().catch(() => undefined);
        throw error;
    }
}

class AgentGymInstance implements AgentGym {
    readonly #home: GymHome;
    readonly #options: AgentGymOptions;
    readonly #scripted: ReturnType<typeof createScriptedInference>;
    readonly #errors: unknown[] = [];
    readonly #timeoutMs: number;
    #daemon: HappyAgentDaemon | undefined;
    #http: GymHttpClient | undefined;
    #token = "";

    constructor(home: GymHome, options: AgentGymOptions) {
        this.#home = home;
        this.#options = options;
        this.#timeoutMs = options.timeoutMs ?? 10_000;
        this.#scripted = createScriptedInference({
            ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
            ...(options.inference === undefined ? {} : { inference: options.inference }),
            ...(options.models === undefined ? {} : { models: options.models }),
        });
    }

    async start(): Promise<void> {
        const daemon = await startHappyAgentDaemon({
            compute: createGymCompute(),
            happyHome: this.#home.happyHome,
            httpConfiguration: {
                onUnexpectedError: (error: unknown) => {
                    this.#errors.push(error);
                },
                p2pName: "Happy Agent Gym",
            },
            inference: {
                models: this.#scripted.models,
                providers: this.#scripted.providers,
            },
            version: this.#options.version ?? "gym",
        });
        this.#daemon = daemon;
        this.#token = (await readFile(daemon.tokenPath, "utf8")).trim();
        this.#http = new GymHttpClient({
            socketPath: daemon.socketPath,
            timeoutMs: Math.max(this.#timeoutMs, 20_000),
            token: this.#token,
        });
    }

    get happyHome(): string {
        return this.#home.happyHome;
    }

    get workspacePath(): string {
        return this.#home.workspacePath;
    }

    get socketPath(): string {
        return this.#running.socketPath;
    }

    get token(): string {
        return this.#token;
    }

    get http(): GymHttpClient {
        if (this.#http === undefined) throw new Error("This gym is not running.");
        return this.#http;
    }

    get inference(): GymInferenceLog {
        return this.#scripted.log;
    }

    get daemon(): HappyAgentDaemon {
        return this.#running;
    }

    get agent(): StartedHappyAgent {
        return this.#running.agent;
    }

    get modules(): HappyAgentModules {
        return this.#running.agent.modules;
    }

    get rootSessionId(): string {
        return this.#running.agent.rootAgentId;
    }

    get selection(): GymSelection {
        return {
            effort: "medium",
            modelId: this.#scripted.models[0]?.id ?? GYM_MODEL_ID,
            providerId: this.#scripted.models[0]?.providerId ?? GYM_PROVIDER_ID,
            serviceTier: null,
        };
    }

    get errors(): readonly unknown[] {
        return this.#errors;
    }

    async send(text: string, options: GymSendOptions = {}): Promise<GymAcceptance> {
        const acceptance = await this.http.ok<GymAcceptance>(
            "POST",
            `/v0/sessions/${this.#sessionId(options.sessionId)}/messages`,
            this.#messageBody(text, options),
        );
        if (options.wait ?? true) await this.waitForRun(acceptance.runId);
        return acceptance;
    }

    async steer(text: string, options: GymSendOptions = {}): Promise<GymAcceptance> {
        const acceptance = await this.http.ok<GymAcceptance>(
            "POST",
            `/v0/sessions/${this.#sessionId(options.sessionId)}/steer`,
            this.#messageBody(text, options),
        );
        if (options.wait === true) await this.waitForRun(acceptance.runId);
        return acceptance;
    }

    async waitForRun(runId: string, timeoutMs = this.#timeoutMs): Promise<AgentEvent> {
        return await this.waitForEvent(
            (event) => event.type === "loop.settled" && runIdOf(event) === runId,
            `run ${runId} to settle`,
            timeoutMs,
        );
    }

    async abort(sessionId?: string): Promise<unknown> {
        return await this.http.ok("POST", `/v0/sessions/${this.#sessionId(sessionId)}/abort`, {
            await: true,
        });
    }

    async compact(sessionId?: string): Promise<unknown> {
        return await this.http.ok("POST", `/v0/sessions/${this.#sessionId(sessionId)}/compact`, {
            await: true,
        });
    }

    async createSession(options: GymCreateSessionOptions = {}): Promise<GymSessionRecord> {
        const selection = this.selection;
        const body = await this.http.ok<{ readonly session: GymSessionRecord }>(
            "POST",
            "/v0/sessions",
            {
                cwd: options.cwd ?? this.workspacePath,
                effort: options.effort ?? selection.effort,
                modelId: options.modelId ?? selection.modelId,
                providerId: options.providerId ?? selection.providerId,
                serviceTier: null,
                ...(options.id === undefined ? {} : { id: options.id }),
                ...(options.permissionMode === undefined
                    ? {}
                    : { permissionMode: options.permissionMode }),
            },
        );
        return body.session;
    }

    async listSessions(): Promise<readonly GymSessionRecord[]> {
        const body = await this.http.ok<{ readonly sessions: readonly GymSessionRecord[] }>(
            "GET",
            "/v0/sessions",
        );
        return body.sessions;
    }

    async getSession(sessionId?: string): Promise<GymSessionRecord> {
        const body = await this.http.ok<{ readonly session: GymSessionRecord }>(
            "GET",
            `/v0/sessions/${this.#sessionId(sessionId)}`,
        );
        return body.session;
    }

    async sessionEvents(sessionId?: string): Promise<readonly Record<string, unknown>[]> {
        const body = await this.http.ok<{
            readonly events: readonly Record<string, unknown>[];
        }>("GET", `/v0/sessions/${this.#sessionId(sessionId)}/events`);
        return body.events;
    }

    async events(): Promise<readonly AgentEvent[]> {
        const journal = this.modules.events;
        const response = await this.http.get<{ readonly events?: readonly AgentEvent[] }>(
            `/v0/events?after=${encodeURIComponent(journal.originCursor())}&limit=${String(
                journal.capacity(),
            )}`,
        );
        if (response.status !== 200) {
            throw new Error(
                `The Happy agent answered ${String(response.status)} for its events: ` +
                    response.text,
            );
        }
        return response.body.events ?? [];
    }

    async waitForEvent(
        predicate: (event: AgentEvent) => boolean,
        description = "a matching event",
        timeoutMs = this.#timeoutMs,
    ): Promise<AgentEvent> {
        let seen: readonly AgentEvent[] = [];
        return await this.waitUntil(
            async () => {
                seen = await this.events();
                return seen.find(predicate);
            },
            () => `${description}. Recorded: ${seen.map((event) => event.type).join(", ")}`,
            timeoutMs,
        );
    }

    async waitUntil<Result>(
        check: () => Result | undefined | Promise<Result | undefined>,
        description: string | (() => string) = "a condition",
        timeoutMs = this.#timeoutMs,
    ): Promise<Result> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const result = await check();
            if (result !== undefined) return result;
            if (Date.now() >= deadline) {
                const text = typeof description === "function" ? description() : description;
                throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${text}`);
            }
            await sleep(20);
        }
    }

    stream(path = "/v0/events/live", options: GymEventStreamOptions = {}): GymEventStream {
        return this.http.stream(path, { timeoutMs: this.#timeoutMs, ...options });
    }

    async readFile(path: string): Promise<string> {
        return await readFile(resolveFixturePath(this.workspacePath, path), "utf8");
    }

    async writeFile(path: string, content: string): Promise<void> {
        await writeFile(resolveFixturePath(this.workspacePath, path), content, "utf8");
    }

    async exists(path: string): Promise<boolean> {
        try {
            await readFile(resolveFixturePath(this.workspacePath, path));
            return true;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "EISDIR") return true;
            return false;
        }
    }

    async listFiles(): Promise<readonly string[]> {
        const entries = await readdir(this.workspacePath, {
            recursive: true,
            withFileTypes: true,
        });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => relative(this.workspacePath, `${entry.parentPath}/${entry.name}`))
            .sort();
    }

    async restart(): Promise<void> {
        await this.#running.close();
        this.#daemon = undefined;
        this.#http = undefined;
        await this.start();
    }

    async dispose(): Promise<void> {
        await this.#daemon?.close().catch(() => undefined);
        this.#daemon = undefined;
        this.#http = undefined;
        await this.#home.remove().catch(() => undefined);
    }

    get #running(): HappyAgentDaemon {
        if (this.#daemon === undefined) throw new Error("This gym is not running.");
        return this.#daemon;
    }

    #sessionId(sessionId: string | undefined): string {
        return sessionId ?? this.rootSessionId;
    }

    #messageBody(text: string, options: GymSendOptions): Record<string, unknown> {
        const selection = this.selection;
        return {
            await: options.await ?? true,
            effort: options.effort ?? selection.effort,
            modelId: options.modelId ?? selection.modelId,
            providerId: options.providerId ?? selection.providerId,
            serviceTier: null,
            text,
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
            ...(options.permissionMode === undefined
                ? {}
                : { permissionMode: options.permissionMode }),
        };
    }
}

/** The run an event belongs to, for the events that name one. */
export function runIdOf(event: AgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const runId = (payload as { readonly runId?: unknown }).runId;
    return typeof runId === "string" ? runId : undefined;
}

/** Delete a path inside a gym workspace. Exported for scenarios that arrange missing files. */
export async function removeWorkspacePath(gym: AgentGym, path: string): Promise<void> {
    await rm(resolveFixturePath(gym.workspacePath, path), { force: true, recursive: true });
}
