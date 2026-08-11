import {
    createRootContext,
    GracefulShutdown as StdlibGracefulShutdown,
    withShutdown,
    type GracefulShutdownReport,
} from "@steve.kite/stdlib";

export interface GracefulShutdown {
    readonly signal: AbortSignal;
    readonly shuttingDown: boolean;
    register(name: string, handler: () => Promise<void>): () => void;
    pending(): readonly string[];
    shutdown(options?: { timeout?: number }): Promise<GracefulShutdownReport>;
}

export { type GracefulShutdownReport };

/** Adapts stdlib's coordinator to Rig's signal-shaped lifecycle boundary. */
export function gracefulShutdown(): GracefulShutdown {
    const coordinator = new StdlibGracefulShutdown();
    withShutdown(createRootContext(), coordinator);
    const controller = new AbortController();
    return {
        signal: controller.signal,
        get shuttingDown() {
            return coordinator.shuttingDown;
        },
        register(name, handler) {
            return coordinator.register(name, async () => await handler());
        },
        pending() {
            return coordinator.pending();
        },
        shutdown(options) {
            controller.abort();
            return coordinator.shutdown(options);
        },
    };
}
