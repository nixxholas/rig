import type { ConfigProviders } from "../config/types.js";
import type {
    ModelCatalog,
    P2pCredentialVisibility,
    ProviderCredentialProvenance as ProtocolProviderCredentialProvenance,
    ProviderModelCatalog,
} from "../protocol/index.js";

export type CredentialVisibility = P2pCredentialVisibility;

export interface ProviderCredentialSource {
    catalog: ModelCatalog;
    instanceId: string;
    name: string;
    providers: ConfigProviders;
    visibility: Readonly<Record<string, CredentialVisibility>>;
}

export type ProviderCredentialProvenance = ProtocolProviderCredentialProvenance;

export type ProvenancedProviderModelCatalog = ProviderModelCatalog & {
    credential: ProviderCredentialProvenance;
    title: string;
};

export interface OwnerProviderScope {
    catalog: Omit<ModelCatalog, "providers"> & {
        providers: readonly ProvenancedProviderModelCatalog[];
    };
    providers: ConfigProviders;
    providerBindings: ReadonlyMap<string, ProviderCredentialProvenance>;
}

/**
 * Builds the inference surface for one session owner.
 *
 * The owner's own provider IDs are authoritative and remain byte-for-byte unchanged. Providers
 * from the daemon or another peer are additive extras. Every extra gets an effective runtime ID
 * namespaced by its source owner; its source ID remains visible in provenance and its title.
 */
export function buildOwnerProviderScope(options: {
    localInstanceId: string;
    ownerInstanceId: string;
    sources: readonly ProviderCredentialSource[];
}): OwnerProviderScope {
    const local = options.sources.find((source) => source.instanceId === options.localInstanceId);
    const uploadedOwner = options.sources.find(
        (source) => source.instanceId === options.ownerInstanceId,
    );
    // A peer that supplied no credentials intentionally gets the receiving Rig's arbitrary local
    // inference surface. Once it supplies a snapshot, that snapshot becomes authoritative.
    const owner = uploadedOwner ?? local;
    if (owner === undefined) {
        throw new Error("No inference credential source is available for this session owner.");
    }

    const providers: Record<string, ConfigProviders[string]> = {};
    const providerCatalogs: ProvenancedProviderModelCatalog[] = [];
    const providerBindings = new Map<string, ProviderCredentialProvenance>();

    const append = (
        source: ProviderCredentialSource,
        candidate: ProviderModelCatalog,
        relation: "owner" | "extra",
    ): void => {
        const sourceProviderId = candidate.providerId;
        const originalConfig = source.providers[sourceProviderId];
        if (originalConfig === undefined) return;
        const visibility = source.visibility[sourceProviderId] ?? "owner_only";
        if (relation === "extra" && visibility !== "shared") {
            return;
        }
        const providerId =
            relation === "owner"
                ? sourceProviderId
                : extraProviderId(sourceProviderId, source.instanceId, providers);
        const credential: ProviderCredentialProvenance = {
            bindingId: `${source.instanceId}:${sourceProviderId}`,
            ownerInstanceId: source.instanceId,
            ownerName: source.name,
            relation,
            sourceProviderId,
            visibility,
        };
        providers[providerId] = originalConfig;
        providerBindings.set(providerId, credential);
        providerCatalogs.push({
            ...candidate,
            credential,
            providerId,
            title:
                relation === "owner"
                    ? `${sourceProviderId} — ${source.name}`
                    : `${sourceProviderId} — provided by ${source.name}`,
        });
    };

    for (const candidate of owner.catalog.providers) append(owner, candidate, "owner");
    for (const source of options.sources) {
        if (source === owner) continue;
        for (const candidate of source.catalog.providers) append(source, candidate, "extra");
    }

    const availableProviders = providerCatalogs.filter(
        (provider) => provider.disabledReason === undefined && provider.models.length > 0,
    );
    const defaultProvider =
        providerCatalogs.find(
            (provider) =>
                provider.credential.relation === "owner" &&
                provider.credential.sourceProviderId === owner.catalog.defaultProviderId,
        ) ?? availableProviders[0];
    const defaultModel =
        defaultProvider?.models.find((model) => model.id === owner.catalog.defaultModelId) ??
        defaultProvider?.models[0];
    if (defaultProvider === undefined || defaultModel === undefined) {
        throw new Error("No inference models are available for this session owner.");
    }

    const models = new Map(
        availableProviders
            .flatMap((provider) => provider.models)
            .map((model) => [model.id, model] as const),
    );
    return {
        catalog: {
            defaultModelId: defaultModel.id,
            defaultProviderId: defaultProvider.providerId,
            models: [...models.values()],
            providers: providerCatalogs,
        },
        providers,
        providerBindings,
    };
}

function extraProviderId(
    sourceProviderId: string,
    ownerInstanceId: string,
    providers: Readonly<Record<string, unknown>>,
): string {
    const base = `${sourceProviderId}@${ownerInstanceId}`;
    if (providers[base] === undefined) return base;
    let suffix = 2;
    while (providers[`${base}-${String(suffix)}`] !== undefined) suffix += 1;
    return `${base}-${String(suffix)}`;
}
