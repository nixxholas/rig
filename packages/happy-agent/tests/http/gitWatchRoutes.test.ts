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
import { createGitRepository } from "../projects/support.js";

interface Fixture {
    readonly call: HttpCall;
    readonly directory: string;
}

type HttpCall = (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
) => Promise<{ readonly status: number; readonly body: Record<string, never> }>;

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

describe("git watching over the daemon socket", () => {
    it("watches nothing without complaining, so a client with no folders on screen can poll", async () => {
        const fixture = await startTestDaemon();

        const answer = await fixture.call("POST", "/v0/git/watch", { entities: [] });

        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({ snapshots: [] });
    }, 30_000);

    it("reports the folders it was asked about", async () => {
        const fixture = await startTestDaemon();
        const folder = await createGitRepository(join(fixture.directory, "work", "alpha"));
        const registered = await fixture.call("POST", "/v0/projects", { path: folder });
        const projectId = (registered.body as unknown as { project: { id: string } }).project.id;

        const answer = await fixture.call("POST", "/v0/git/watch", {
            entities: [{ projectId }],
        });

        expect(answer.status).toBe(200);
        expect(Array.isArray((answer.body as unknown as { snapshots: unknown }).snapshots)).toBe(
            true,
        );
    }, 30_000);
});

async function startTestDaemon(): Promise<Fixture> {
    const scratch = resolve(import.meta.dirname, "../../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await realpath(await mkdtemp(join(scratch, "ha-git-")));
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
        version: "git-watch-route-test",
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
