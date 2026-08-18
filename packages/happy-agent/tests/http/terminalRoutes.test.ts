import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

import {
    RemoteTerminalProtocolClient,
    type RemoteTerminalGridState,
    type RemoteTerminalReplica,
} from "@slopus/ghostty-web";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
    AgentProviders,
    createNodeBinaryWebSocket,
    startHappyAgentDaemon,
    WebSocketDuplex,
    type AgentModel,
    type HappyAgentDaemon,
} from "../../sources/index.js";
import { createGitRepository } from "../projects/support.js";

interface Fixture {
    readonly call: HttpCall;
    readonly directory: string;
    readonly socketPath: string;
    readonly token: string;
}

type HttpCall = (
    method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
    path: string,
    body?: unknown,
) => Promise<{ readonly status: number; readonly body: Record<string, never> }>;

const running = new Set<{ readonly daemon: HappyAgentDaemon; readonly directory: string }>();
const attachments: RemoteTerminalProtocolClient[] = [];

afterEach(async () => {
    for (const client of attachments.splice(0)) client.close();
    await Promise.all(
        [...running].map(async ({ daemon, directory }) => {
            await daemon.close().catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("terminal routes over the daemon socket", () => {
    it("runs a real terminal in the project folder and replays it to an attachment", async () => {
        const fixture = await startTestDaemon();
        const projectId = await registerProject(fixture, "alpha");
        const collection = `/v0/projects/${encodeURIComponent(projectId)}/terminals`;

        const created = await fixture.call("POST", collection, {
            cols: 40,
            rows: 6,
            command: "printf 'hello-from-the-terminal\\n'",
        });
        expect(created.status).toBe(201);
        const terminal = readTerminal(created.body);
        expect(terminal).toMatchObject({ cols: 40, colorScheme: "dark", rows: 6, status: "running" });

        // What the process printed reaches an attachment as ordered terminal bytes, applied by the
        // replica rather than rendered by the daemon.
        const attachment = await attach(fixture, `${collection}/${terminal.id}/attach`);
        const exitCode = await attachment.exited;
        expect(exitCode).toBe(0);
        expect(attachment.text()).toContain("hello-from-the-terminal");

        const listed = await fixture.call("GET", collection);
        expect(readTerminals(listed.body)).toEqual([
            expect.objectContaining({ exitCode: 0, id: terminal.id, status: "exited" }),
        ]);
    }, 30_000);

    it("resizes and stops a terminal, and lists it per folder", async () => {
        const fixture = await startTestDaemon();
        const projectId = await registerProject(fixture, "beta");
        const collection = `/v0/projects/${encodeURIComponent(projectId)}/terminals`;

        const created = await fixture.call("POST", collection, { cols: 40, rows: 6 });
        const terminal = readTerminal(created.body);

        const resized = await fixture.call("PATCH", `${collection}/${terminal.id}`, {
            cols: 100,
            rows: 30,
        });
        expect(resized.status).toBe(200);
        expect(readTerminal(resized.body)).toMatchObject({ cols: 100, rows: 30 });

        const stopped = await fixture.call("DELETE", `${collection}/${terminal.id}`);
        expect(stopped.status).toBe(200);
        expect(readTerminal(stopped.body).status).toBe("exited");
    }, 30_000);

    it("refuses a folder and a terminal nobody has, and an attachment without the token", async () => {
        const fixture = await startTestDaemon();
        const projectId = await registerProject(fixture, "gamma");
        const collection = `/v0/projects/${encodeURIComponent(projectId)}/terminals`;

        expect((await fixture.call("GET", "/v0/projects/nope/terminals")).status).toBe(404);
        expect((await fixture.call("DELETE", `${collection}/nope`)).status).toBe(404);
        expect((await fixture.call("PATCH", `${collection}/nope`, { cols: 0, rows: 1 })).status).toBe(
            400,
        );
        expect(
            (await fixture.call("GET", `/v0/projects/${projectId}/workspaces/nope/terminals`)).status,
        ).toBe(404);

        const created = await fixture.call("POST", collection, {});
        const terminal = readTerminal(created.body);
        await expect(
            openWebSocket(fixture.socketPath, `${collection}/${terminal.id}/attach`, "wrong-token"),
        ).rejects.toThrow();
        await expect(
            openWebSocket(fixture.socketPath, `${collection}/nope/attach`, fixture.token),
        ).rejects.toThrow();
    }, 30_000);
});

/** A replica that keeps only what the test asks about: the rows the protocol put on the screen. */
class RecordingReplica implements RemoteTerminalReplica {
    grid: RemoteTerminalGridState | undefined;

    applyGrid(state: RemoteTerminalGridState): void {
        this.grid = state;
    }

    applyVt(): void {
        throw new Error("This replica reads the semantic grid, not raw terminal bytes.");
    }

    resize(): void {}
}

async function attach(
    fixture: Fixture,
    path: string,
): Promise<{
    readonly exited: Promise<number | null>;
    readonly text: () => string;
}> {
    const replica = new RecordingReplica();
    const webSocket = await openWebSocket(fixture.socketPath, path, fixture.token);
    let settleExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((settle) => {
        settleExit = settle;
    });
    const client = new RemoteTerminalProtocolClient({
        // A grid renderer, so the test needs no terminal emulator of its own to read the screen.
        capabilities: { grid: true, vt: false },
        clientId: "terminal-route-test",
        onExit: settleExit,
        replica,
        stream: new WebSocketDuplex(createNodeBinaryWebSocket(webSocket)),
    });
    attachments.push(client);
    await client.ready;
    return {
        exited,
        text: () =>
            (replica.grid?.rows ?? [])
                .map((row) => row.cells.map((cell) => cell.text).join(""))
                .join("\n"),
    };
}

async function openWebSocket(
    socketPath: string,
    path: string,
    token: string,
): Promise<WebSocket> {
    return await new Promise((settle, reject) => {
        const webSocket = new WebSocket(`ws+unix://${socketPath}:${path}`, {
            handshakeTimeout: 10_000,
            headers: { authorization: `Bearer ${token}` },
            perMessageDeflate: false,
        });
        webSocket.once("error", reject);
        webSocket.once("unexpected-response", (_request, response) => {
            response.resume();
            reject(new Error(`The attachment was refused with HTTP ${response.statusCode ?? 0}.`));
        });
        webSocket.once("open", () => {
            webSocket.off("error", reject);
            settle(webSocket);
        });
    });
}

async function registerProject(fixture: Fixture, name: string): Promise<string> {
    const folder = await createGitRepository(join(fixture.directory, "work", name));
    const registered = await fixture.call("POST", "/v0/projects", { path: folder });
    expect(registered.status).toBe(200);
    const project = (registered.body as { project?: { id?: string } }).project;
    if (project?.id === undefined) throw new Error("The project was not registered.");
    return project.id;
}

function readTerminal(body: Record<string, never>): {
    cols: number;
    colorScheme: string;
    exitCode: number | null;
    id: string;
    rows: number;
    status: string;
} {
    const terminal = (body as { terminal?: unknown }).terminal;
    if (terminal === undefined) throw new Error("The response carried no terminal.");
    return terminal as ReturnType<typeof readTerminal>;
}

function readTerminals(body: Record<string, never>): readonly unknown[] {
    const terminals = (body as { terminals?: unknown }).terminals;
    if (!Array.isArray(terminals)) throw new Error("The response carried no terminals.");
    return terminals;
}

async function startTestDaemon(): Promise<Fixture> {
    const scratch = resolve(import.meta.dirname, "../../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await realpath(await mkdtemp(join(scratch, "ha-terminal-")));
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
        version: "terminal-route-test",
    });
    running.add({ daemon, directory });
    const token = (await readFile(daemon.tokenPath, "utf8")).trim();
    return {
        call: createCall(daemon.socketPath, token),
        directory,
        socketPath: daemon.socketPath,
        token,
    };
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
