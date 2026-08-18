import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
} from "../../sources/index.js";
import { createGitRepository, waitFor } from "../projects/support.js";

interface Fixture {
    readonly call: HttpCall;
    readonly directory: string;
}

type HttpCall = (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
) => Promise<{ readonly status: number; readonly body: Record<string, never> }>;

interface CatalogSnapshot {
    readonly projects: readonly { readonly id: string; readonly name: string }[];
    readonly workspaces: readonly { readonly id: string; readonly projectId: string }[];
}

const running = new Set<{ readonly daemon: HappyAgentDaemon; readonly directory: string }>();

afterEach(async () => {
    await Promise.all(
        [...running].map(async ({ daemon, directory }) => {
            await daemon.close().catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("the catalog a client opens with", () => {
    it("carries the projects and workspaces the daemon actually has", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "alpha"));

        const registered = await fixture.call("POST", "/v0/projects", { path: folder });
        expect(registered.status).toBe(200);
        const projectId = readProjectId(registered.body);
        const created = await fixture.call(
            "POST",
            `/v0/projects/${encodeURIComponent(projectId)}/workspaces`,
            { name: "review" },
        );
        expect(created.status).toBe(202);
        const workspaceId = readWorkspaceId(created.body);

        const catalog = await waitFor(async () => {
            const answer = await fixture.call("GET", "/v0/catalog");
            const snapshot = answer.body as unknown as CatalogSnapshot;
            return snapshot.projects.length > 0 ? snapshot : undefined;
        }, "the catalog to carry the registered project");

        expect(catalog.projects.map((project) => project.id)).toEqual([projectId]);
        expect(catalog.projects[0]?.name).toBe("alpha");
        expect(catalog.workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
        expect(catalog.workspaces[0]?.projectId).toBe(projectId);
    }, 60_000);
});

function readProjectId(body: Record<string, never>): string {
    return (body as unknown as { readonly project: { readonly id: string } }).project.id;
}

function readWorkspaceId(body: Record<string, never>): string {
    return (body as unknown as { readonly workspace: { readonly id: string } }).workspace.id;
}

async function startTestDaemon(): Promise<Fixture> {
    const scratch = resolve(import.meta.dirname, "../../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await realpath(await mkdtemp(join(scratch, "ha-catalog-")));
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
    const daemon = await startHappyAgentDaemon({
        happyHome: join(directory, ".happy"),
        inference: { models, providers },
        version: "catalog-snapshot-test",
    });
    running.add({ daemon, directory });
    const token = (await readFile(daemon.tokenPath, "utf8")).trim();
    return { call: createCall(daemon.socketPath, token), directory };
}

function createCall(socketPath: string, token: string): HttpCall {
    return async (method, path, body) =>
        await new Promise((settle, reject) => {
            const payload =
                body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
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
