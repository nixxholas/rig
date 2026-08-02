export const DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS = 10_000;

export type PluginStartupTerminalState =
    | { status: "running" }
    | { error: string; status: "failed" };

/**
 * One plugin process generation's startup transition.
 *
 * `starting` is deliberately not recoverable: ready and failure are terminal for the generation,
 * so a late registration cannot bring a timed-out process back into the catalog.
 */
export class PluginStartupState {
    readonly settled: Promise<PluginStartupTerminalState>;
    #resolve: (state: PluginStartupTerminalState) => void = () => undefined;
    #state: { status: "starting" } | PluginStartupTerminalState = { status: "starting" };

    constructor() {
        this.settled = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    get status(): "starting" | PluginStartupTerminalState["status"] {
        return this.#state.status;
    }

    assertStarting(contribution: string): void {
        if (this.#state.status === "starting") return;
        throw new Error(
            this.#state.status === "failed"
                ? `${contribution} arrived after this plugin generation failed to start.`
                : contribution === "Plugin readiness"
                  ? "Plugin readiness was already reported for this plugin generation."
                  : `${contribution} must be declared before the plugin reports ready.`,
        );
    }

    assertActive(contribution: string): void {
        if (this.#state.status !== "failed") return;
        throw new Error(`${contribution} arrived after this plugin generation failed to start.`);
    }

    ready(): void {
        this.assertStarting("Plugin readiness");
        this.#transition({ status: "running" });
    }

    fail(error: string): boolean {
        if (this.#state.status !== "starting") return false;
        this.#transition({ error, status: "failed" });
        return true;
    }

    #transition(state: PluginStartupTerminalState): void {
        this.#state = state;
        this.#resolve(state);
    }
}
