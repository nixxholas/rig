export interface GracefulShutdown {
    /** Fires when shutdown begins. Pass it to `forever`, `delay`, and `backoff`. */
    readonly signal: AbortSignal;
    readonly shuttingDown: boolean;
    /**
     * Registers a handler under a name. Registering the same name again
     * replaces the previous handler. Returns a function that unregisters it.
     */
    register(name: string, handler: () => Promise<void>): () => void;
    /** Names that have not finished yet. This is what a slow shutdown is waiting on. */
    pending(): readonly string[];
    /** Begins shutdown and waits for every handler. Safe to call more than once. */
    shutdown(options?: { timeout?: number }): Promise<GracefulShutdownReport>;
}

export interface GracefulShutdownReport {
    /** Handlers that did not finish before the timeout. */
    timedOut: readonly string[];
    /** Handlers that threw, by name. */
    failed: readonly { name: string; error: unknown }[];
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Named handlers the daemon runs and waits for when it starts shutting down.
 *
 * The names carry the whole point: when shutdown drags, `pending()` says
 * exactly what we are waiting for — including which `forever` has not yet come
 * out of its loop.
 */
export function gracefulShutdown(): GracefulShutdown {
    const handlers = new Map<string, () => Promise<void>>();
    const running = new Set<string>();
    const controller = new AbortController();
    let started: Promise<GracefulShutdownReport> | undefined;

    return {
        signal: controller.signal,
        get shuttingDown() {
            return controller.signal.aborted;
        },
        register(name, handler) {
            handlers.set(name, handler);
            return () => {
                // Only remove our own registration, never a later replacement.
                if (handlers.get(name) === handler) handlers.delete(name);
            };
        },
        pending() {
            return [...running];
        },
        shutdown(options = {}) {
            // Shutdown happens once; later callers await the same outcome.
            started ??= runShutdown(
                handlers,
                running,
                controller,
                options.timeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
            );
            return started;
        },
    };
}

async function runShutdown(
    handlers: ReadonlyMap<string, () => Promise<void>>,
    running: Set<string>,
    controller: AbortController,
    timeout: number,
): Promise<GracefulShutdownReport> {
    const failed: { name: string; error: unknown }[] = [];
    // Signal first, so every loop and delay is already unwinding while the
    // handlers below run.
    controller.abort();

    const entries = [...handlers.entries()];
    for (const [name] of entries) running.add(name);

    const settled = entries.map(async ([name, handler]) => {
        try {
            await handler();
        } catch (error) {
            failed.push({ name, error });
        } finally {
            running.delete(name);
        }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeout);
    });
    try {
        const outcome = await Promise.race([Promise.all(settled).then(() => "done"), expired]);
        return {
            // A handler still in `running` is precisely one that never finished.
            timedOut: outcome === "timeout" ? [...running] : [],
            failed,
        };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
