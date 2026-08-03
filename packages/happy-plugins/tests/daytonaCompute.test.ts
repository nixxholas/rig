import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES } from "../sources/index.js";
import { createDaytonaComputeProvider } from "../examples/daytona/daytonaCompute.ts";

const directories: string[] = [];
const context = {
    reportProgress: async () => undefined,
    signal: new AbortController().signal,
};
const observedCommandBodySchema = Type.Object(
    { command: Type.String() },
    { additionalProperties: true },
);

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("Daytona compute example", () => {
    it("maps sandbox creation, source upload, exec, files, and deletion", async () => {
        const source = await createSource();
        const phases: string[] = [];
        const requests: {
            authorization: string | null;
            body: unknown;
            method: string;
            url: string;
        }[] = [];
        const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
            const url = String(input);
            requests.push({
                authorization: new Headers(init.headers).get("authorization"),
                body: await observedBody(init.body),
                method: init.method ?? "GET",
                url,
            });
            if (url.endsWith("/sandbox")) {
                return Response.json({
                    id: "sandbox-1",
                    toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
                });
            }
            if (url.endsWith("/process/execute")) {
                if (decodeWrappedCommand(requests.at(-1)?.body).includes("mv --")) {
                    return commandResponse({
                        exitCode: 0,
                        stderr: "",
                        stderrBytes: 0,
                        stdout: "",
                        stdoutBytes: 0,
                    });
                }
                return commandResponse({
                    exitCode: 7,
                    stderr: "warning",
                    stderrBytes: 7,
                    stdout: "hello",
                    stdoutBytes: 5,
                });
            }
            if (url.includes("/files/download")) return new Response("saved");
            return Response.json({});
        });
        const provider = createDaytonaComputeProvider({
            apiBaseUrl: "https://app.daytona.io/api",
            apiKey: "test-key",
            fetch: fetcher,
        });

        const instanceId = await provider.handlers.start(
            { workspaceSource: { path: source, type: "local_directory" } },
            {
                reportProgress: async (progress) => {
                    phases.push(progress.phase);
                },
                signal: context.signal,
            },
        );
        await expect(
            provider.handlers.exec(
                { command: "printf hello", instanceId, timeoutMs: 1_500 },
                context,
            ),
        ).resolves.toEqual({
            exitCode: 7,
            stderr: "warning",
            stderrTruncated: false,
            stdout: "hello",
            stdoutTruncated: false,
            timedOut: false,
        });
        await provider.handlers.write(
            { bytes: Buffer.from("saved"), instanceId, path: "saved.txt" },
            context,
        );
        await expect(
            provider.handlers.read({ instanceId, path: "saved.txt" }, context),
        ).resolves.toEqual(Buffer.from("saved"));
        await provider.handlers.stop({ instanceId }, context);

        expect(phases).toEqual(["checking_out_code", "copying_files_to_compute"]);
        expect(requests[0]).toMatchObject({
            body: {
                autoDeleteInterval: 0,
                buildInfo: { dockerfileContent: "FROM ubuntu:24.04" },
                ttlMinutes: 120,
            },
            method: "POST",
            url: "https://app.daytona.io/api/sandbox",
        });
        expect(
            requests.some(
                (request) =>
                    request.url.includes("/files/upload-v2") &&
                    request.url.includes(encodeURIComponent("/home/daytona/workspace/message.txt")),
            ),
        ).toBe(true);
        expect(
            requests.find((request) => request.url.endsWith("/process/execute"))?.body,
        ).toMatchObject({
            cwd: "/home/daytona/workspace",
            timeout: 2,
        });
        const atomicUpload = requests.find(
            (request) =>
                request.url.includes("/files/upload-v2") &&
                request.url.includes("saved.txt.happy-compute-"),
        );
        expect(new URL(atomicUpload!.url).searchParams.get("path")).toMatch(
            /^\/home\/daytona\/workspace\/saved\.txt\.happy-compute-.+\.tmp$/,
        );
        const processRequests = requests.filter((request) =>
            request.url.endsWith("/process/execute"),
        );
        expect(decodeWrappedCommand(processRequests[1]?.body)).toContain("mv --");
        expect(requests.at(-1)).toMatchObject({
            method: "DELETE",
            url: "https://app.daytona.io/api/sandbox/sandbox-1",
        });
        expect(requests.every((request) => request.authorization === "Bearer test-key")).toBe(true);
    });

    it("maps truthful command truncation flags from Daytona's bounded wrapper", async () => {
        const source = await createSource();
        const fetcher = daytonaFetchMock(() =>
            commandResponse({
                exitCode: 0,
                stderr: "err",
                stderrBytes: HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES + 1,
                stdout: "out",
                stdoutBytes: HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES + 10,
            }),
        );
        const provider = createDaytonaComputeProvider({
            apiKey: "test-key",
            fetch: fetcher,
        });
        const instanceId = await provider.handlers.start(
            { workspaceSource: { path: source, type: "local_directory" } },
            context,
        );

        await expect(
            provider.handlers.exec({ command: "generate", instanceId, timeoutMs: 1_000 }, context),
        ).resolves.toMatchObject({
            stderr: "err",
            stderrTruncated: true,
            stdout: "out",
            stdoutTruncated: true,
        });
        await provider.close();
    });

    it("maps consumer-caused file API responses without hiding provider failures", async () => {
        const source = await createSource();
        const fetcher = vi.fn<typeof fetch>(async (input) => {
            const url = String(input);
            if (url.endsWith("/sandbox")) {
                return Response.json({
                    id: "sandbox-1",
                    toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
                });
            }
            if (url.includes("/files/download")) {
                return new Response("not found", {
                    status: url.includes("provider-outage.txt") ? 500 : 404,
                });
            }
            if (url.includes("rejected.txt")) {
                return new Response("invalid path", { status: 400 });
            }
            return Response.json({});
        });
        const provider = createDaytonaComputeProvider({
            apiKey: "test-key",
            fetch: fetcher,
        });
        const instanceId = await provider.handlers.start(
            { workspaceSource: { path: source, type: "local_directory" } },
            context,
        );

        await expect(
            provider.handlers.read({ instanceId, path: "missing.txt" }, context),
        ).rejects.toMatchObject({
            code: "invalid_request",
            message: "The requested Daytona file was not found.",
        });
        await expect(
            provider.handlers.write(
                { bytes: Buffer.from("saved"), instanceId, path: "rejected.txt" },
                context,
            ),
        ).rejects.toMatchObject({
            code: "invalid_request",
            message: "Daytona rejected the requested file path.",
        });
        await expect(
            provider.handlers.read({ instanceId, path: "provider-outage.txt" }, context),
        ).rejects.not.toHaveProperty("code");

        await provider.close();
    });

    it("rejects start clearly without a key while remaining constructible", async () => {
        const source = await createSource();
        const fetcher = vi.fn<typeof fetch>();
        const provider = createDaytonaComputeProvider({ fetch: fetcher });

        await expect(
            provider.handlers.start(
                { workspaceSource: { path: source, type: "local_directory" } },
                context,
            ),
        ).rejects.toMatchObject({
            code: "provider_unhealthy",
            message: expect.stringContaining("DAYTONA_API_KEY is missing"),
        });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("reports a stale sandbox ID as instance_not_found", async () => {
        const provider = createDaytonaComputeProvider();

        await expect(
            Promise.resolve(
                provider.handlers.read(
                    { instanceId: "stale-sandbox", path: "message.txt" },
                    context,
                ),
            ),
        ).rejects.toMatchObject({
            code: "instance_not_found",
            message: "The Daytona sandbox was not found.",
        });
    });

    it("treats a 404 delete as success and keeps stop idempotent", async () => {
        const source = await createSource();
        const fetcher = daytonaFetchMock(
            () =>
                commandResponse({
                    exitCode: 0,
                    stderr: "",
                    stderrBytes: 0,
                    stdout: "",
                    stdoutBytes: 0,
                }),
            404,
        );
        const provider = createDaytonaComputeProvider({
            apiKey: "test-key",
            fetch: fetcher,
        });
        const instanceId = await provider.handlers.start(
            { workspaceSource: { path: source, type: "local_directory" } },
            context,
        );

        await expect(provider.handlers.stop({ instanceId }, context)).resolves.toBeUndefined();
        await expect(provider.handlers.stop({ instanceId }, context)).resolves.toBeUndefined();
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    });

    it("never includes the API key in provider errors", async () => {
        const source = await createSource();
        const apiKey = "secret-daytona-key";
        let authorization: string | null = null;
        const provider = createDaytonaComputeProvider({
            apiKey,
            fetch: vi.fn<typeof fetch>(async (_input, init = {}) => {
                authorization = new Headers(init.headers).get("authorization");
                throw new Error(`connection failed for ${apiKey}`);
            }),
        });

        const error = await Promise.resolve(
            provider.handlers.start(
                { workspaceSource: { path: source, type: "local_directory" } },
                context,
            ),
        ).catch((caught: unknown) => caught);
        expect(String(error)).toContain("[redacted]");
        expect(String(error)).not.toContain(apiKey);
        expect(authorization).toBe(`Bearer ${apiKey}`);
    });
});

async function createSource(): Promise<string> {
    const directory = await mkdtemp(join(process.cwd(), "daytona-test-"));
    directories.push(directory);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "message.txt"), "hello");
    await writeFile(join(directory, "nested", "note.txt"), "note");
    return directory;
}

function daytonaFetchMock(
    execute: () => Response,
    deleteStatus = 200,
): ReturnType<typeof vi.fn<typeof fetch>> {
    return vi.fn<typeof fetch>(async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/sandbox")) {
            return Response.json({
                id: "sandbox-1",
                toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
            });
        }
        if (url.endsWith("/process/execute")) return execute();
        if (init.method === "DELETE") {
            return new Response(deleteStatus === 404 ? "not found" : "{}", {
                status: deleteStatus,
            });
        }
        return Response.json({});
    });
}

function commandResponse(output: {
    exitCode: number;
    stderr: string;
    stderrBytes: number;
    stdout: string;
    stdoutBytes: number;
}): Response {
    return Response.json({
        exitCode: 0,
        result: JSON.stringify({
            exitCode: output.exitCode,
            stderrBase64: Buffer.from(output.stderr).toString("base64"),
            stderrBytes: output.stderrBytes,
            stdoutBase64: Buffer.from(output.stdout).toString("base64"),
            stdoutBytes: output.stdoutBytes,
        }),
    });
}

async function observedBody(body: RequestInit["body"]): Promise<unknown> {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return JSON.parse(body) as unknown;
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    return body;
}

function decodeWrappedCommand(body: unknown): string {
    const command = Value.Decode(observedCommandBodySchema, body).command;
    const encoded = /printf %s '([^']+)'/.exec(command)?.[1];
    return encoded === undefined ? "" : Buffer.from(encoded, "base64").toString("utf8");
}
