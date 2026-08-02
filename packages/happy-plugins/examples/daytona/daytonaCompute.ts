import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES,
    HAPPY_COMPUTE_MAX_FILE_BYTES,
    HappyComputeProviderError,
    type HappyComputeProviderHandlers,
} from "happy-plugins";

const DAYTONA_API_URL = "https://app.daytona.io/api";
const DAYTONA_DEFAULT_IMAGE = "ubuntu:24.04";
const DAYTONA_WORKSPACE = "/home/daytona/workspace";
const MAX_SOURCE_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_DAYTONA_JSON_BYTES = 4 * 1024 * 1024;
const exact = { additionalProperties: false } as const;

const optionsSchema = Type.Object(
    {
        apiBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
        apiKey: Type.Optional(Type.String()),
        image: Type.Optional(Type.String({ minLength: 1 })),
    },
    exact,
);
type DaytonaOptions = Static<typeof optionsSchema>;

const sandboxSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    toolboxProxyUrl: Type.String({ minLength: 1 }),
});

const executeResponseSchema = Type.Object({
    exitCode: Type.Optional(Type.Integer()),
    result: Type.String(),
});

const outputBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const commandEnvelopeSchema = Type.Object(
    {
        exitCode: Type.Integer(),
        stderrBase64: outputBase64Schema,
        stderrBytes: Type.Integer({ minimum: 0 }),
        stdoutBase64: outputBase64Schema,
        stdoutBytes: Type.Integer({ minimum: 0 }),
    },
    exact,
);

const instanceSchema = Type.Object(
    {
        id: Type.String({ minLength: 1 }),
        toolboxUrl: Type.String({ minLength: 1 }),
    },
    exact,
);
type DaytonaInstance = Static<typeof instanceSchema>;

export function createDaytonaComputeProvider(
    options: DaytonaOptions & {
        fetch?: typeof fetch;
        log?: (message: string) => void;
    } = {},
): {
    close(): Promise<void>;
    handlers: HappyComputeProviderHandlers;
} {
    const config = Value.Decode(optionsSchema, {
        ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.image === undefined ? {} : { image: options.image }),
    });
    const apiBaseUrl = (config.apiBaseUrl ?? DAYTONA_API_URL).replace(/\/+$/, "");
    const apiKey = config.apiKey?.trim() || undefined;
    const fetcher = options.fetch ?? fetch;
    const image = config.image ?? DAYTONA_DEFAULT_IMAGE;
    const log = options.log ?? safeLog;
    const instances = new Map<string, DaytonaInstance>();
    let closed = false;

    const requireInstance = (instanceId: string) => {
        const instance = instances.get(instanceId);
        if (instance === undefined) {
            throw new HappyComputeProviderError(
                "instance_not_found",
                "The Daytona sandbox was not found.",
            );
        }
        return instance;
    };
    const request = (url: string, init: RequestInit, acceptedStatuses: readonly number[] = []) =>
        daytonaFetch(fetcher, url, init, apiKey, acceptedStatuses);

    return {
        handlers: {
            async start({ workspaceSource }, context) {
                if (closed) {
                    throw new HappyComputeProviderError(
                        "provider_unhealthy",
                        "The Daytona compute provider is stopping.",
                    );
                }
                if (apiKey === undefined) {
                    throw new HappyComputeProviderError(
                        "provider_unhealthy",
                        "DAYTONA_API_KEY is missing. Set it before starting a Daytona sandbox.",
                    );
                }
                let source: string;
                try {
                    source = await realpath(workspaceSource.path);
                } catch {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        "The Daytona compute source directory is unavailable.",
                    );
                }
                if (!(await lstat(source)).isDirectory()) {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        "The Daytona compute source must be a directory.",
                    );
                }
                const response = await request(`${apiBaseUrl}/sandbox`, {
                    body: JSON.stringify({
                        autoDeleteInterval: 0,
                        buildInfo: { dockerfileContent: `FROM ${image}` },
                        ttlMinutes: 120,
                    }),
                    headers: jsonHeaders(),
                    method: "POST",
                    signal: context.signal,
                });
                const sandbox = Value.Decode(
                    sandboxSchema,
                    await readJsonResponse(response, MAX_DAYTONA_JSON_BYTES),
                );
                const instance = Value.Decode(instanceSchema, {
                    id: sandbox.id,
                    toolboxUrl: `${sandbox.toolboxProxyUrl.replace(/\/+$/, "")}/${encodeURIComponent(sandbox.id)}`,
                });
                instances.set(instance.id, instance);
                try {
                    await uploadSource(instance, source, request, context.signal, log);
                } catch (error) {
                    instances.delete(instance.id);
                    await deleteSandbox(apiBaseUrl, instance.id, apiKey, request).catch(
                        () => undefined,
                    );
                    throw error;
                }
                return instance.id;
            },
            async read({ instanceId, path }, context) {
                const instance = requireInstance(instanceId);
                let response: Response;
                try {
                    response = await request(
                        `${instance.toolboxUrl}/files/download?path=${encodeURIComponent(remotePath(path))}`,
                        { method: "GET", signal: context.signal },
                    );
                } catch (error) {
                    if (error instanceof DaytonaHttpError && error.status === 404) {
                        throw new HappyComputeProviderError(
                            "invalid_request",
                            "The requested Daytona file was not found.",
                        );
                    }
                    throw error;
                }
                return readBoundedResponse(response, HAPPY_COMPUTE_MAX_FILE_BYTES);
            },
            async write({ bytes, instanceId, path }, context) {
                const instance = requireInstance(instanceId);
                let response: Response;
                try {
                    response = await request(
                        `${instance.toolboxUrl}/files/upload-v2?path=${encodeURIComponent(remotePath(path))}`,
                        {
                            body: bytes,
                            headers: { "content-type": "application/octet-stream" },
                            method: "POST",
                            signal: context.signal,
                        },
                    );
                } catch (error) {
                    if (error instanceof DaytonaHttpError && error.status === 400) {
                        throw new HappyComputeProviderError(
                            "invalid_request",
                            "Daytona rejected the requested file path.",
                        );
                    }
                    throw error;
                }
                await response.body?.cancel();
            },
            async exec({ command, instanceId, timeoutMs }, context) {
                const instance = requireInstance(instanceId);
                let response: Response;
                try {
                    response = await request(`${instance.toolboxUrl}/process/execute`, {
                        body: JSON.stringify({
                            command: commandWrapper(command),
                            cwd: DAYTONA_WORKSPACE,
                            timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                        signal: context.signal,
                    });
                } catch (error) {
                    if (error instanceof DaytonaHttpError && error.status === 408) {
                        return {
                            exitCode: null,
                            stderr: "",
                            stderrTruncated: false,
                            stdout: "",
                            stdoutTruncated: false,
                            timedOut: true,
                        };
                    }
                    throw error;
                }
                const execute = Value.Decode(
                    executeResponseSchema,
                    await readJsonResponse(response, MAX_DAYTONA_JSON_BYTES),
                );
                const envelope = Value.Decode(
                    commandEnvelopeSchema,
                    JSON.parse(execute.result) as unknown,
                );
                const stdout = Buffer.from(envelope.stdoutBase64, "base64");
                const stderr = Buffer.from(envelope.stderrBase64, "base64");
                if (
                    stdout.byteLength > HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES ||
                    stderr.byteLength > HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES
                ) {
                    throw new Error("Daytona returned command output beyond Rig's size limit.");
                }
                return {
                    exitCode: envelope.exitCode,
                    stderr: stderr.toString("utf8"),
                    stderrTruncated: envelope.stderrBytes > HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES,
                    stdout: stdout.toString("utf8"),
                    stdoutTruncated: envelope.stdoutBytes > HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES,
                    timedOut: false,
                };
            },
            async stop({ instanceId }) {
                const instance = instances.get(instanceId);
                if (instance === undefined) return;
                instances.delete(instanceId);
                await deleteSandbox(apiBaseUrl, instance.id, apiKey, request);
            },
        },
        async close() {
            if (closed) return;
            closed = true;
            const ids = [...instances.keys()];
            instances.clear();
            await Promise.allSettled(
                ids.map((id) => deleteSandbox(apiBaseUrl, id, apiKey, request)),
            );
        },
    };
}

async function uploadSource(
    instance: DaytonaInstance,
    source: string,
    request: (
        url: string,
        init: RequestInit,
        acceptedStatuses?: readonly number[],
    ) => Promise<Response>,
    signal: AbortSignal,
    log: (message: string) => void,
): Promise<void> {
    let uploaded = 0;
    for await (const path of walkFiles(source)) {
        signal.throwIfAborted();
        const info = await lstat(path);
        const name = relative(source, path).split(sep).join("/");
        if (info.size > HAPPY_COMPUTE_MAX_FILE_BYTES) {
            log(`Skipped "${name}" because it is larger than the 1 MiB compute file limit.`);
            continue;
        }
        if (uploaded + info.size > MAX_SOURCE_UPLOAD_BYTES) {
            log(
                `Stopped the Daytona source upload before "${name}" because it reached its 32 MiB limit.`,
            );
            break;
        }
        const bytes = await readFile(path);
        const response = await request(
            `${instance.toolboxUrl}/files/upload-v2?path=${encodeURIComponent(`${DAYTONA_WORKSPACE}/${name}`)}`,
            {
                body: bytes,
                headers: { "content-type": "application/octet-stream" },
                method: "POST",
                signal,
            },
        );
        await response.body?.cancel();
        uploaded += bytes.byteLength;
    }
}

async function* walkFiles(directory: string): AsyncGenerator<string> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) yield* walkFiles(path);
        else if (entry.isFile()) yield path;
    }
}

function remotePath(path: string): string {
    return `${DAYTONA_WORKSPACE}/${path}`;
}

function commandWrapper(command: string): string {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const cap = String(HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES);
    return [
        "tmp=$(mktemp -d)",
        `printf %s '${encoded}' | base64 -d > "$tmp/command"`,
        `/bin/bash "$tmp/command" >"$tmp/stdout" 2>"$tmp/stderr"`,
        "code=$?",
        'stdout_bytes=$(wc -c <"$tmp/stdout" | tr -d " ")',
        'stderr_bytes=$(wc -c <"$tmp/stderr" | tr -d " ")',
        `stdout=$(head -c ${cap} "$tmp/stdout" | base64 | tr -d '\\n')`,
        `stderr=$(head -c ${cap} "$tmp/stderr" | base64 | tr -d '\\n')`,
        `printf '{"exitCode":%s,"stdoutBytes":%s,"stderrBytes":%s,"stdoutBase64":"%s","stderrBase64":"%s"}' "$code" "$stdout_bytes" "$stderr_bytes" "$stdout" "$stderr"`,
        'rm -rf "$tmp"',
        "exit 0",
    ].join("; ");
}

async function deleteSandbox(
    apiBaseUrl: string,
    id: string,
    apiKey: string | undefined,
    request: (
        url: string,
        init: RequestInit,
        acceptedStatuses?: readonly number[],
    ) => Promise<Response>,
): Promise<void> {
    if (apiKey === undefined) return;
    const response = await request(
        `${apiBaseUrl}/sandbox/${encodeURIComponent(id)}`,
        {
            method: "DELETE",
        },
        [404],
    );
    await response.body?.cancel();
}

async function daytonaFetch(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit,
    apiKey: string | undefined,
    acceptedStatuses: readonly number[],
): Promise<Response> {
    let response: Response;
    try {
        const headers = new Headers(init.headers);
        if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
        response = await fetcher(url, { ...init, headers });
    } catch (error) {
        throw new Error(sanitize(`Daytona could not be reached. ${errorToMessage(error)}`, apiKey));
    }
    if (response.ok || acceptedStatuses.includes(response.status)) return response;
    const detail = await readBoundedText(response, 64 * 1024).catch(() => "");
    if (response.status === 429) {
        throw new HappyComputeProviderError(
            "capacity_exhausted",
            sanitize(
                `Daytona has no sandbox capacity available${detail === "" ? "." : `: ${detail}`}`,
                apiKey,
            ),
        );
    }
    throw new DaytonaHttpError(
        response.status,
        sanitize(
            `Daytona rejected the request with HTTP ${String(response.status)}${detail === "" ? "." : `: ${detail}`}`,
            apiKey,
        ),
    );
}

class DaytonaHttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "DaytonaHttpError";
    }
}

function jsonHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
}

async function readJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
    return JSON.parse(await readBoundedText(response, maximumBytes)) as unknown;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
    return Buffer.from(await readBoundedResponse(response, maximumBytes)).toString("utf8");
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maximumBytes) {
        await response.body?.cancel();
        throw new Error(`Daytona returned more than ${String(maximumBytes)} bytes.`);
    }
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximumBytes) {
            await reader.cancel();
            throw new Error(`Daytona returned more than ${String(maximumBytes)} bytes.`);
        }
        chunks.push(next.value);
    }
    return Buffer.concat(chunks, bytes);
}

function sanitize(message: string, apiKey: string | undefined): string {
    return apiKey === undefined || apiKey === ""
        ? message
        : message.split(apiKey).join("[redacted]");
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function safeLog(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Upload diagnostics cannot fail the provider.
    }
}
