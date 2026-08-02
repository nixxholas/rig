export const PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS = 5_000;

export async function withPluginDockerDeadline<T>(
    operation: Promise<T>,
    options: { action: string; timeoutMs?: number },
): Promise<T> {
    const timeoutMs = options.timeoutMs ?? PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `${options.action} did not finish within ${formatDuration(timeoutMs)}.`,
                            ),
                        ),
                    timeoutMs,
                );
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function formatDuration(milliseconds: number): string {
    return milliseconds % 1_000 === 0
        ? `${String(milliseconds / 1_000)} seconds`
        : `${String(milliseconds)} milliseconds`;
}
