export const DEFAULT_WORKLET_STARTUP_TIMEOUT_MS = 10_000;

export type WorkletStartupTerminalState =
    | { status: "running" }
    | { error: string; status: "failed" };

/**
 * One worklet process generation's startup transition.
 *
 * `starting` is deliberately not recoverable: ready and failure are terminal for the generation,
 * so a late tool registration cannot bring a timed-out process back into the catalog.
 */
export class WorkletStartupState {
    readonly settled: Promise<WorkletStartupTerminalState>;
    #resolve: (state: WorkletStartupTerminalState) => void = () => undefined;
    #state: { status: "starting" } | WorkletStartupTerminalState = { status: "starting" };

    constructor() {
        this.settled = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    get status(): "starting" | WorkletStartupTerminalState["status"] {
        return this.#state.status;
    }

    assertStarting(contribution: string): void {
        if (this.#state.status === "starting") return;
        throw new Error(
            this.#state.status === "failed"
                ? `${contribution} arrived after this worklet failed to start.`
                : contribution === "Worklet readiness"
                  ? "Worklet readiness was already reported."
                  : `${contribution} must be declared before the worklet reports ready.`,
        );
    }

    assertActive(contribution: string): void {
        if (this.#state.status !== "failed") return;
        throw new Error(`${contribution} arrived after this worklet failed to start.`);
    }

    ready(): void {
        this.assertStarting("Worklet readiness");
        this.#transition({ status: "running" });
    }

    fail(error: string): boolean {
        if (this.#state.status !== "starting") return false;
        this.#transition({ error, status: "failed" });
        return true;
    }

    #transition(state: WorkletStartupTerminalState): void {
        this.#state = state;
        this.#resolve(state);
    }
}
