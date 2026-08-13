import type { BaseProvider, ProviderModelCompatibilityType } from "@slopus/happy-providers";

/**
 * Mutable registry of happy-providers instances keyed by a caller-supplied provider ID, so the
 * same provider class can be registered under several IDs (for example per credential). Each
 * entry carries its compatibility type, which decides how far a model change can go before the
 * conversation must reset. Providers can be added and removed while the process runs; lookups
 * return the live reference or null when absent.
 */
export class AgentProviders {
    /** Registered providers keyed by their caller-supplied ID, alongside their compatibility type. */
    readonly #providers = new Map<
        string,
        { readonly provider: BaseProvider; readonly type: ProviderModelCompatibilityType }
    >();

    /** Register a provider under `id`. Throws if that ID is already registered. */
    add(id: string, provider: BaseProvider, type: ProviderModelCompatibilityType): void {
        if (this.#providers.has(id)) {
            throw new Error(`Provider "${id}" is already registered.`);
        }
        this.#providers.set(id, { provider, type });
    }

    /** Unregister the provider at `id`. Returns whether one was actually removed. */
    remove(id: string): boolean {
        return this.#providers.delete(id);
    }

    /** The live provider instance registered at `id`, or null when none is registered. */
    get(id: string): BaseProvider | null {
        return this.#providers.get(id)?.provider ?? null;
    }

    /** The compatibility type the provider at `id` was registered with, or null when absent. */
    typeOf(id: string): ProviderModelCompatibilityType | null {
        return this.#providers.get(id)?.type ?? null;
    }

    /** Every currently registered provider ID. */
    get ids(): readonly string[] {
        return [...this.#providers.keys()];
    }
}
