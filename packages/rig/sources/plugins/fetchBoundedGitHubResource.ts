export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

export class GitHubResourceFetchError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "GitHubResourceFetchError";
        this.status = status;
    }
}

export async function fetchBoundedGitHubResource(options: {
    accept: string;
    description: string;
    fetcher?: GitHubFetch;
    maximumBytes: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    url: string;
}): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const signal =
        options.signal === undefined
            ? timeout.signal
            : AbortSignal.any([options.signal, timeout.signal]);
    try {
        const response = await (options.fetcher ?? globalThis.fetch)(options.url, {
            headers: {
                accept: options.accept,
                "user-agent": "Rig plugin discovery",
            },
            redirect: "follow",
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new GitHubResourceFetchError(
                `GitHub returned HTTP ${String(response.status)} while fetching ${options.description}.`,
                response.status,
            );
        }
        const declaredLength = response.headers.get("content-length");
        if (
            declaredLength !== null &&
            /^\d+$/u.test(declaredLength) &&
            Number(declaredLength) > options.maximumBytes
        ) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge(options.description, options.maximumBytes);
        }
        if (response.body === null) return new Uint8Array();

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > options.maximumBytes) {
                await reader.cancel().catch(() => undefined);
                throw tooLarge(options.description, options.maximumBytes);
            }
            chunks.push(next.value);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return body;
    } catch (error) {
        if (options.signal?.aborted === true) {
            options.signal.throwIfAborted();
        }
        if (timeout.signal.aborted) {
            throw new GitHubResourceFetchError(
                `${options.description} did not finish within ${String(timeoutMs / 1000)} seconds.`,
            );
        }
        if (error instanceof GitHubResourceFetchError) throw error;
        throw new GitHubResourceFetchError(
            `Rig could not fetch ${options.description} from GitHub: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        clearTimeout(timer);
    }
}

function tooLarge(description: string, maximumBytes: number): GitHubResourceFetchError {
    return new GitHubResourceFetchError(
        `${description} is larger than the ${formatBytes(maximumBytes)} download limit.`,
    );
}

function formatBytes(bytes: number): string {
    return bytes % (1024 * 1024) === 0
        ? `${String(bytes / (1024 * 1024))} MB`
        : `${String(bytes)} byte`;
}
