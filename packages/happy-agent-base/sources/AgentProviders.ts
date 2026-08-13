import type { BaseProvider, ProviderModelCompatibilityType } from "@slopus/happy-providers";

/** The serializable provider/model selection a provider source resolves. */
export interface AgentProviderSelection {
    /** The caller-defined registration ID of the provider. */
    readonly id: string;
    /** The model whose provider instance is needed, if the agent selected one. */
    readonly model: string | undefined;
}

/**
 * Either one provider suitable for every selected model or a lazy model-aware provider factory.
 * Providers own no session lifetime; each AgentBase owns and destroys the sessions it opens.
 */
export type AgentProviderSource =
    | BaseProvider
    | ((selection: AgentProviderSelection) => BaseProvider | Promise<BaseProvider>);

/**
 * Mutable registry of model-aware provider sources keyed by caller-supplied IDs. Each entry carries
 * its compatibility type, which decides how far a model change can go before the conversation
 * must reset.
 */
export class AgentProviders {
    /** Registered provider sources keyed by their caller-supplied ID and compatibility type. */
    readonly #providers = new Map<
        string,
        { readonly source: AgentProviderSource; readonly type: ProviderModelCompatibilityType }
    >();

    /** Register a provider source under `id`. Throws if that ID is already registered. */
    add(id: string, source: AgentProviderSource, type: ProviderModelCompatibilityType): void {
        if (this.#providers.has(id)) {
            throw new Error(`Provider "${id}" is already registered.`);
        }
        this.#providers.set(id, { source, type });
    }

    /** Unregister the provider at `id`. Returns whether one was actually removed. */
    remove(id: string): boolean {
        return this.#providers.delete(id);
    }

    /** Resolve the provider suitable for `model`, or null when `id` is not registered. */
    async resolve(id: string, model: string | undefined): Promise<BaseProvider | null> {
        const entry = this.#providers.get(id);
        if (entry === undefined) return null;
        return typeof entry.source === "function"
            ? await entry.source({ id, model })
            : entry.source;
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
