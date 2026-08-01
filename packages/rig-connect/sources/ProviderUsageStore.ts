import type {
    ProviderUsageDelta,
    ProviderUsageEntry,
    ProviderUsageState,
} from "./ProviderUsageElement.js";

const LOADING: ProviderUsageState = { loading: true, loadedAt: null, error: null };

export class ProviderUsageStore {
    #providers: readonly ProviderUsageEntry[] = [];
    #state: ProviderUsageState = LOADING;

    providers(): readonly ProviderUsageEntry[] {
        return this.#providers;
    }

    state(): ProviderUsageState {
        return this.#state;
    }

    /** Records a successful read, which always ends the loading state. */
    applyProviders(providers: readonly ProviderUsageEntry[], at: number): ProviderUsageDelta[] {
        const deltas: ProviderUsageDelta[] = [];
        if (!sameProviders(this.#providers, providers)) {
            this.#providers = providers;
            deltas.push({ providers, type: "providers_changed" });
        }
        return [...deltas, ...this.#setState({ loading: false, loadedAt: at, error: null })];
    }

    /**
     * Records a failed read. Readings already held are kept: a poll that could
     * not reach the daemon does not make what we last saw untrue, and every
     * reading carries its own capture time for a view to judge.
     */
    applyError(error: string): ProviderUsageDelta[] {
        return this.#setState({
            loading: false,
            loadedAt: this.#state.loadedAt,
            error,
        });
    }

    #setState(next: ProviderUsageState): ProviderUsageDelta[] {
        if (
            this.#state.loading === next.loading &&
            this.#state.loadedAt === next.loadedAt &&
            this.#state.error === next.error
        ) {
            return [];
        }
        this.#state = next;
        return [{ state: next, type: "provider_usage_state_changed" }];
    }
}

/**
 * Usage moves slowly and a poll usually returns exactly what it returned
 * before, so identical answers are compared away rather than waking every view
 * on a timer.
 */
function sameProviders(
    before: readonly ProviderUsageEntry[],
    after: readonly ProviderUsageEntry[],
): boolean {
    return before.length === after.length && JSON.stringify(before) === JSON.stringify(after);
}
