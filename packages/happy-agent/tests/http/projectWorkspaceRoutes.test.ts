import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createRootContext, type RootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
    type HappyAgentIntegrations,
} from "../../sources/index.js";
import { createGitRepository, git, waitFor } from "../projects/support.js";

interface Fixture {
    readonly ctx: RootContext;
    readonly daemon: HappyAgentDaemon;
    readonly directory: string;
    readonly managedWorkspaces: string;
    readonly token: string;
    readonly call: HttpCall;
}

type HttpCall = (
    method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
    path: string,
    options?: {
        readonly body?: unknown;
        readonly headers?: Readonly<Record<string, string>>;
        readonly raw?: Buffer;
    },
) => Promise<{ readonly status: number; readonly body: Record<string, never> }>;

const running = new Set<{
    readonly ctx: RootContext;
    readonly daemon: HappyAgentDaemon;
    readonly directory: string;
    readonly restoreEnvironment: () => void;
}>();

afterEach(async () => {
    await Promise.all(
        [...running].map(async ({ ctx, daemon, directory, restoreEnvironment }) => {
            await daemon.close(ctx.named("test-cleanup")).catch(() => undefined);
            restoreEnvironment();
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("project and workspace routes over the daemon socket", () => {
    it("makes the folder a session starts in its project, and reuses it next time", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "alpha"));

        const first = await fixture.call("POST", "/v0/sessions", { body: { cwd: folder } });
        expect(first.status).toBe(201);
        const scope = sessionScope(first.body);
        expect(scope).toMatchObject({ kind: "project" });

        const projects = await fixture.call("GET", "/v0/projects");
        expect(projects.body).toMatchObject({
            projects: [
                expect.objectContaining({
                    id: scope.projectId,
                    kind: "regular",
                    name: "alpha",
                    path: folder,
                    status: "active",
                }),
            ],
        });

        const second = await fixture.call("POST", "/v0/sessions", { body: { cwd: folder } });
        expect(sessionScope(second.body)).toEqual(scope);
        const after = await fixture.call("GET", "/v0/projects");
        expect(readProjects(after.body)).toHaveLength(1);
    });

    it("brings an archived project back when a session starts in its folder again", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "beta"));
        const created = await fixture.call("POST", "/v0/sessions", { body: { cwd: folder } });
        const projectId = sessionScope(created.body).projectId;

        const before = await fixture.call("GET", `/v0/projects/${projectId}`);
        const archived = await fixture.call("POST", `/v0/projects/${projectId}/archive`, {
            body: {},
            headers: { "if-match": String(readProject(before.body).version) },
        });
        expect(archived.status).toBe(202);
        expect(readProject(archived.body).status).toBe("archived");

        const reopened = await fixture.call("POST", "/v0/sessions", { body: { cwd: folder } });
        expect(sessionScope(reopened.body)).toMatchObject({ kind: "project", projectId });
        const now = await fixture.call("GET", `/v0/projects/${projectId}`);
        expect(readProject(now.body).status).toBe("active");
    });

    it("treats the person's home directory as the Home project", async () => {
        const fixture = await startTestDaemon();
        const home = await realpath(homedir());

        const created = await fixture.call("POST", "/v0/sessions", { body: { cwd: home } });
        const projectId = sessionScope(created.body).projectId;
        const project = await fixture.call("GET", `/v0/projects/${projectId}`);

        expect(readProject(project.body)).toMatchObject({
            kind: "home",
            name: "Home",
            path: home,
        });
    });

    it("cuts a real branch and worktree for a workspace and records where they are", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "gamma"));
        const projectId = await importProject(fixture, folder);
        const baseCommit = await git(folder, "rev-parse", "HEAD");

        const created = await fixture.call("POST", `/v0/projects/${projectId}/workspaces`, {
            body: { name: "Try something" },
        });
        expect(created.status).toBe(202);
        const workspaceId = readWorkspace(created.body).id;
        const ready = await readyWorkspace(fixture, projectId, workspaceId);

        expect(ready).toMatchObject({
            baseCommit,
            branch: "worktree/try-something",
            kind: "git_worktree",
            name: "Try something",
            presence: "present",
            status: "ready",
        });
        expect(String(ready.path).startsWith(fixture.managedWorkspaces)).toBe(true);
        expect(existsSync(String(ready.path))).toBe(true);
        expect(await git(String(ready.path), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
            "worktree/try-something",
        );
        expect(await git(String(ready.path), "rev-parse", "HEAD")).toBe(baseCommit);
    }, 60_000);

    it("moves the Git branch when a workspace is renamed", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "delta"));
        const projectId = await importProject(fixture, folder);
        const created = await fixture.call("POST", `/v0/projects/${projectId}/workspaces`, {
            body: { name: "First idea" },
        });
        const workspaceId = readWorkspace(created.body).id;
        const ready = await readyWorkspace(fixture, projectId, workspaceId);

        const renamed = await fixture.call(
            "PATCH",
            `/v0/projects/${projectId}/workspaces/${workspaceId}`,
            {
                body: { name: "Second idea" },
                headers: { "if-match": String(ready.version) },
            },
        );
        expect(renamed.status).toBe(200);
        expect(readWorkspace(renamed.body)).toMatchObject({
            branch: "worktree/second-idea",
            name: "Second idea",
        });

        await waitFor(
            async () =>
                (await git(String(ready.path), "rev-parse", "--abbrev-ref", "HEAD")) ===
                "worktree/second-idea"
                    ? true
                    : undefined,
            "the Git branch to follow the workspace name",
        );
    }, 60_000);

    it("removes the worktree on archive and stays archived when cleanup cannot finish", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "epsilon"));
        const projectId = await importProject(fixture, folder);

        const first = await fixture.call("POST", `/v0/projects/${projectId}/workspaces`, {
            body: { name: "Cleanly removed" },
        });
        const cleanId = readWorkspace(first.body).id;
        const clean = await readyWorkspace(fixture, projectId, cleanId);
        const archived = await fixture.call(
            "POST",
            `/v0/projects/${projectId}/workspaces/${cleanId}/archive`,
            { body: {}, headers: { "if-match": String(clean.version) } },
        );
        expect(archived.status).toBe(202);
        await archivedWorkspace(fixture, projectId, cleanId);
        expect(existsSync(String(clean.path))).toBe(false);

        const second = await fixture.call("POST", `/v0/projects/${projectId}/workspaces`, {
            body: { name: "Cleanup fails" },
        });
        const brokenId = readWorkspace(second.body).id;
        const broken = await readyWorkspace(fixture, projectId, brokenId);
        // Taking the project's Git away is exactly the situation the durable rule is for: the
        // decision to archive has been made and Git can no longer be asked to undo the worktree.
        await rm(join(folder, ".git"), { force: true, recursive: true });
        const refused = await fixture.call(
            "POST",
            `/v0/projects/${projectId}/workspaces/${brokenId}/archive`,
            { body: {}, headers: { "if-match": String(broken.version) } },
        );
        expect(refused.status).toBe(202);
        expect(await archivedWorkspace(fixture, projectId, brokenId)).toMatchObject({
            status: "archived",
        });
    }, 60_000);

    it("lists only the workspaces a project still has unless archived ones are asked for", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "zeta"));
        const projectId = await importProject(fixture, folder);
        const created = await fixture.call("POST", `/v0/projects/${projectId}/workspaces`, {
            body: { name: "Gone soon" },
        });
        const workspaceId = readWorkspace(created.body).id;
        const ready = await readyWorkspace(fixture, projectId, workspaceId);
        await fixture.call("POST", `/v0/projects/${projectId}/workspaces/${workspaceId}/archive`, {
            body: {},
            headers: { "if-match": String(ready.version) },
        });

        const active = await fixture.call("GET", `/v0/projects/${projectId}/workspaces`);
        expect(readWorkspaces(active.body)).toEqual([]);
        const all = await fixture.call(
            "GET",
            `/v0/projects/${projectId}/workspaces?includeArchived=true`,
        );
        expect(readWorkspaces(all.body)).toHaveLength(1);
    }, 60_000);

    it("answers every route that used to be unavailable", async () => {
        const fixture = await startTestDaemon();
        const first = await createGitRepository(join(fixture.directory, "work", "eta"));
        const second = await createGitRepository(join(fixture.directory, "work", "theta"));
        const firstId = await importProject(fixture, first);
        const secondId = await importProject(fixture, second);

        const refreshed = await fixture.call("POST", `/v0/projects/${firstId}/refresh`);
        expect(refreshed.status).toBe(202);
        expect(readProject(refreshed.body).initializationStatus).toBe("initializing");

        const current = await fixture.call("GET", `/v0/projects/${secondId}`);
        const reordered = await fixture.call("POST", `/v0/projects/${secondId}/reorder`, {
            body: { afterId: null },
            headers: { "if-match": String(readProject(current.body).version) },
        });
        expect(reordered.status).toBe(200);
        const ordered = await fixture.call("GET", "/v0/projects");
        expect(readProjects(ordered.body)[0]).toMatchObject({ id: secondId });

        const image = await sharp({
            create: {
                background: { b: 40, g: 120, r: 200 },
                channels: 3,
                height: 32,
                width: 32,
            },
        })
            .png()
            .toBuffer();
        const beforeAvatar = await fixture.call("GET", `/v0/projects/${firstId}`);
        const withAvatar = await fixture.call("PUT", `/v0/projects/${firstId}/avatar`, {
            headers: {
                "content-type": "image/png",
                "if-match": String(readProject(beforeAvatar.body).version),
            },
            raw: image,
        });
        expect(withAvatar.status).toBe(200);
        const avatar = readProject(withAvatar.body).avatar as {
            readonly hash: string;
            readonly mediaType?: string;
            readonly url: string;
        };
        expect(avatar.mediaType ?? "image/webp").toBe("image/webp");

        const asset = await fixture.call("GET", `/v0/project-assets/${avatar.hash}`);
        expect(asset.status).toBe(200);

        const cleared = await fixture.call("DELETE", `/v0/projects/${firstId}/avatar`, {
            headers: { "if-match": String(readProject(withAvatar.body).version) },
        });
        expect(cleared.status).toBe(200);
        expect(readProject(cleared.body).avatar).toBeUndefined();

        const workspace = await fixture.call("POST", `/v0/projects/${secondId}/workspaces`, {
            body: { name: "Reorder me" },
        });
        const workspaceId = readWorkspace(workspace.body).id;
        const ready = await readyWorkspace(fixture, secondId, workspaceId);
        const movedWorkspace = await fixture.call(
            "POST",
            `/v0/projects/${secondId}/workspaces/${workspaceId}/reorder`,
            { body: { afterId: null }, headers: { "if-match": String(ready.version) } },
        );
        expect(movedWorkspace.status).toBe(200);
    }, 60_000);

    it("refuses a mutation whose If-Match no longer matches the row", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "iota"));
        const projectId = await importProject(fixture, folder);
        const current = await fixture.call("GET", `/v0/projects/${projectId}`);
        const version = readProject(current.body).version as number;

        const renamed = await fixture.call("PATCH", `/v0/projects/${projectId}`, {
            body: { name: "Renamed once" },
            headers: { "if-match": String(version) },
        });
        expect(renamed.status).toBe(200);
        expect(readProject(renamed.body).version).toBeGreaterThan(version);

        const stale = await fixture.call("PATCH", `/v0/projects/${projectId}`, {
            body: { name: "Renamed again" },
            headers: { "if-match": String(version) },
        });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({
            currentVersion: readProject(renamed.body).version,
            project: expect.objectContaining({ name: "Renamed once" }),
        });
    });

    it("refuses a clone from a remote nobody could clone", async () => {
        const fixture = await startTestDaemon();
        // The identity is deliberately wrong in both calls. The clonable remote gets as far as
        // that check, so the 400 below is the remote being refused rather than the request.
        const clonable = await fixture.call("POST", "/v0/projects/clone", {
            body: {
                identity: "not-this-agent",
                name: "Elsewhere",
                source: { kind: "git", url: "https://example.test/team/repository.git" },
            },
        });
        expect(clonable.status).toBe(403);

        for (const url of [
            "https://token@example.test/team/repository.git",
            "git@example.test:team/repository.git",
            "http://example.test/team/repository.git",
        ]) {
            const refused = await fixture.call("POST", "/v0/projects/clone", {
                body: {
                    identity: "not-this-agent",
                    name: "Elsewhere",
                    source: { kind: "git", url },
                },
            });
            expect(refused.status).toBe(400);
        }
    });

    it("serves a workspace's files from the folder the record names", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "kappa"));
        const projectId = await importProject(fixture, folder);
        const created = await fixture.call("POST", `/v0/projects/${projectId}/workspaces`, {
            body: { name: "Read me" },
        });
        const workspaceId = readWorkspace(created.body).id;
        const ready = await readyWorkspace(fixture, projectId, workspaceId);

        const listed = await fixture.call(
            "GET",
            `/v0/projects/${projectId}/workspaces/${workspaceId}/file-tree`,
        );
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({
            entries: expect.arrayContaining([expect.objectContaining({ name: "README.md" })]),
        });
        expect(await readFile(join(String(ready.path), "README.md"), "utf8")).toContain("# Test");
    }, 60_000);
});

async function importProject(fixture: Fixture, path: string): Promise<string> {
    const response = await fixture.call("POST", "/v0/projects", { body: { path } });
    expect(response.status).toBe(200);
    return String(readProject(response.body).id);
}

async function readyWorkspace(
    fixture: Fixture,
    projectId: string,
    workspaceId: string,
): Promise<Record<string, unknown>> {
    return await waitFor(async () => {
        const response = await fixture.call(
            "GET",
            `/v0/projects/${projectId}/workspaces/${workspaceId}`,
        );
        const workspace = readWorkspace(response.body);
        if (workspace.status === "failed") {
            throw new Error(`Workspace setup failed: ${String(workspace.initializationError)}`);
        }
        return workspace.status === "ready" ? workspace : undefined;
    }, "the workspace checkout to be ready");
}

async function archivedWorkspace(
    fixture: Fixture,
    projectId: string,
    workspaceId: string,
): Promise<Record<string, unknown>> {
    return await waitFor(async () => {
        const response = await fixture.call(
            "GET",
            `/v0/projects/${projectId}/workspaces/${workspaceId}`,
        );
        const workspace = readWorkspace(response.body);
        return workspace.status === "archived" ? workspace : undefined;
    }, "the archived workspace to finish cleanup");
}

function sessionScope(body: Record<string, never>): {
    readonly kind: string;
    readonly projectId: string;
    readonly workspaceId?: string;
} {
    const session = (body as { session?: { scope?: unknown } }).session;
    return session?.scope as { kind: string; projectId: string; workspaceId?: string };
}

function readProject(body: Record<string, never>): Record<string, unknown> {
    return (body as { project?: Record<string, unknown> }).project ?? {};
}

function readProjects(body: Record<string, never>): readonly Record<string, unknown>[] {
    return (body as { projects?: Record<string, unknown>[] }).projects ?? [];
}

function readWorkspace(body: Record<string, never>): Record<string, unknown> {
    return (body as { workspace?: Record<string, unknown> }).workspace ?? {};
}

function readWorkspaces(body: Record<string, never>): readonly Record<string, unknown>[] {
    return (body as { workspaces?: Record<string, unknown>[] }).workspaces ?? [];
}

/**
 * A whole daemon on its own socket, with its managed folders inside the test's directory.
 *
 * The managed directories are chosen through the same environment variables a person would use,
 * because that is the only way to keep a test's worktrees out of the real `~/Happy/Workspaces`.
 */
async function startTestDaemon(): Promise<Fixture> {
    const scratch = resolve(import.meta.dirname, "../../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await realpath(await mkdtemp(join(scratch, "ha-http-")));
    const managedProjects = join(directory, "managed-projects");
    const managedWorkspaces = join(directory, "managed-workspaces");
    const previous = {
        projects: process.env.RIG_PROJECTS_DIRECTORY,
        workspaces: process.env.RIG_WORKSPACES_DIRECTORY,
    };
    process.env.RIG_PROJECTS_DIRECTORY = managedProjects;
    process.env.RIG_WORKSPACES_DIRECTORY = managedWorkspaces;
    const restoreEnvironment = (): void => {
        setEnvironment("RIG_PROJECTS_DIRECTORY", previous.projects);
        setEnvironment("RIG_WORKSPACES_DIRECTORY", previous.workspaces);
    };

    const providers = new AgentProviders();
    providers.add("scripted", scriptedProvider(), "gym");
    const models: readonly AgentModel[] = [
        {
            defaultEffort: "medium",
            effortLevels: ["low", "medium", "high"],
            id: "scripted-model",
            name: "Scripted Model",
            providerId: "scripted",
        },
    ];
    const ctx = createRootContext() as unknown as RootContext;
    let daemon: HappyAgentDaemon;
    try {
        daemon = await startHappyAgentDaemon(ctx, {
            happyHome: join(directory, ".happy"),
            integrations: unavailableIntegrations(),
            models,
            provider: "scripted",
            providers,
            version: "project-route-test",
        });
    } catch (error) {
        restoreEnvironment();
        throw error;
    }
    running.add({ ctx, daemon, directory, restoreEnvironment });
    const token = (await readFile(daemon.tokenPath, "utf8")).trim();
    return {
        call: createCall(daemon.socketPath, token),
        ctx,
        daemon,
        directory,
        managedWorkspaces,
        token,
    };
}

function setEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function createCall(socketPath: string, token: string): HttpCall {
    return async (method, path, options = {}) =>
        await new Promise((settle, reject) => {
            const payload =
                options.raw ??
                (options.body === undefined
                    ? undefined
                    : Buffer.from(JSON.stringify(options.body), "utf8"));
            const request = httpRequest(
                {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${token}`,
                        ...(payload === undefined
                            ? {}
                            : {
                                  "content-length": String(payload.byteLength),
                                  "content-type": "application/json",
                              }),
                        ...options.headers,
                    },
                    method,
                    path,
                    socketPath,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("error", reject);
                    response.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const contentType = response.headers["content-type"] ?? "";
                        settle({
                            body: contentType.includes("application/json")
                                ? (JSON.parse(text) as Record<string, never>)
                                : ({} as Record<string, never>),
                            status: response.statusCode ?? 500,
                        });
                    });
                },
            );
            request.on("error", reject);
            if (payload !== undefined) request.write(payload);
            request.end();
        });
}

function scriptedProvider(): Parameters<AgentProviders["add"]>[1] {
    return {
        inputTypes: ["text"],
        name: "scripted",
        outputTypes: ["text"],
        session: async (id: string) => ({
            id,
            compact: async () => {
                throw new Error("Compaction is unavailable in this test.");
            },
            destroy: () => undefined,
            run: () =>
                (async function* () {
                    yield { type: "text_start" } as const;
                    yield { type: "text_delta", delta: "Happy Agent replied." } as const;
                    yield { type: "text_end" } as const;
                    yield { type: "done", state: "normal" } as const;
                })(),
        }),
    } as never;
}

function unavailableIntegrations(): HappyAgentIntegrations {
    const unavailable = async () => {
        throw new Error("This integration is unavailable in this test.");
    };
    return {
        collaboration: {
            create: async (_ctx, _config, options) => ({ id: options.id }),
            config: async () => undefined,
            interrupt: unavailable,
            observe: unavailable,
            selection: async () => undefined,
            send: async () => undefined,
            setReadOnly: unavailable,
            spawnCapacity: async () => ({ canSpawn: false, depth: 0, maxDepth: 0 }),
            wait: unavailable,
            waitForAgent: unavailable,
        },
        happy: {
            notify: async () => ({ accepted: false }),
            setStatus: async () => ({ accepted: false }),
        },
        imageGeneration: { generate: unavailable },
        mcp: {
            callTool: unavailable,
            getPrompt: unavailable,
            listPrompts: async () => ({ prompts: [] }),
            listResourceTemplates: async () => ({ resourceTemplates: [] }),
            listResources: async () => ({ resources: [] }),
            listServers: async () => ({ servers: [] }),
            listTools: async () => ({ tools: [] }),
            readResource: unavailable,
        },
        scheduling: {
            cancel: unavailable,
            reportDelivery: unavailable,
            schedule: unavailable,
            startWait: unavailable,
            wait: unavailable,
        },
        search: {
            fetch: async (_ctx, _agentId, input) => ({
                content: "",
                truncated: false,
                url: input.url,
            }),
            search: async (_ctx, _agentId, query) => ({ query: query.query, results: [] }),
        },
        userInput: { wait: unavailable },
        workflows: {
            cancel: unavailable,
            launch: unavailable,
            resume: unavailable,
            wait: unavailable,
        },
    } as unknown as HappyAgentIntegrations;
}
