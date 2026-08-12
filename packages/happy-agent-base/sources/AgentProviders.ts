import type { BaseProvider, ProviderModelCompatibilityType } from "@slopus/happy-providers";

/**
 * Mutable registry of happy-providers instances keyed by a caller-supplied provider ID, so the
 * same provider class can be registered under several IDs (for example per credential). Each
 * entry carries its compatibility type, which decides how far a model change can go before the
 * conversation must reset. Providers can be added and removed while the process runs; lookups
 * return the live reference or null when absent.
 */
export class AgentProviders {
    readonly #providers = new Map<
        string,
        { readonly provider: BaseProvider; readonly type: ProviderModelCompatibilityType }
    >();

    add(id: string, provider: BaseProvider, type: ProviderModelCompatibilityType): void {
        if (this.#providers.has(id)) {
            throw new Error(`Provider "${id}" is already registered.`);
        }
        this.#providers.set(id, { provider, type });
    }

    remove(id: string): boolean {
        return this.#providers.delete(id);
    }

    get(id: string): BaseProvider | null {
        return this.#providers.get(id)?.provider ?? null;
    }

    typeOf(id: string): ProviderModelCompatibilityType | null {
        return this.#providers.get(id)?.type ?? null;
    }

    get ids(): readonly string[] {
        return [...this.#providers.keys()];
    }
}
