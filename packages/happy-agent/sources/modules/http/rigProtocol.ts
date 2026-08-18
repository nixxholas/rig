import { Type, type Static } from "@sinclair/typebox";
import type { AgentModel, AgentProviders } from "@slopus/happy-agent-base";

export const HAPPY_AGENT_RIG_PROTOCOL_VERSION = 17;

const exact = { additionalProperties: false } as const;
const MAX_CATALOG_MODELS = 512;
const MAX_CATALOG_PROVIDERS = 128;

const thinkingLevelSchema = Type.String({ minLength: 1, maxLength: 32 });
const modalitySchema = Type.String({ minLength: 1, maxLength: 32 });
const compatibilitySchema = Type.String({ minLength: 1, maxLength: 64 });

/**
 * What a provider says about the models it serves, beyond their names and efforts.
 *
 * `inputTypes` and `outputTypes` are the modalities the provider accepts and produces, and
 * `compatibility` is the group it was registered under: two models in the same group can be
 * swapped without the conversation being reset.
 */
const declaredCapabilityProperties = {
    compatibility: Type.Optional(compatibilitySchema),
    inputTypes: Type.Optional(Type.Array(modalitySchema, { maxItems: 16 })),
    outputTypes: Type.Optional(Type.Array(modalitySchema, { maxItems: 16 })),
} as const;

export const rigModelSummarySchema = Type.Object(
    {
        ...declaredCapabilityProperties,
        defaultThinkingLevel: thinkingLevelSchema,
        id: Type.String({ minLength: 1, maxLength: 256 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        thinkingLevels: Type.Array(thinkingLevelSchema, { maxItems: 16 }),
    },
    exact,
);

export const rigModelCatalogProviderSchema = Type.Object(
    {
        ...declaredCapabilityProperties,
        models: Type.Array(rigModelSummarySchema, { maxItems: MAX_CATALOG_MODELS }),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTiers: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 16 }),
        ),
    },
    exact,
);

export const rigModelCatalogSchema = Type.Object(
    {
        defaultModelId: Type.String({ maxLength: 256 }),
        defaultProviderId: Type.String({ maxLength: 256 }),
        models: Type.Array(rigModelSummarySchema, { maxItems: MAX_CATALOG_MODELS }),
        providers: Type.Array(rigModelCatalogProviderSchema, { maxItems: MAX_CATALOG_PROVIDERS }),
    },
    exact,
);

export type RigModelSummary = Static<typeof rigModelSummarySchema>;
export type RigModelCatalogProvider = Static<typeof rigModelCatalogProviderSchema>;
export type RigModelCatalog = Static<typeof rigModelCatalogSchema>;

/** Everything one registered provider declares about itself. */
export interface RigProviderCapabilities {
    readonly compatibility: string;
    readonly inputTypes: readonly string[];
    readonly outputTypes: readonly string[];
}

interface RigProviderModalities {
    readonly inputTypes: readonly string[];
    readonly outputTypes: readonly string[];
}

/**
 * A provider declares its modalities on its own class, but a registry entry is a recipe rather
 * than an instance: asking for them builds the provider, which reads a credential. The answer
 * cannot change while a registration stands, so each registry is asked once per provider and the
 * answer is kept for every later catalog read.
 */
const declaredModalities = new WeakMap<
    AgentProviders,
    Map<string, Promise<RigProviderModalities | undefined>>
>();

export interface RigPresenceConfiguration {
    readonly current?: string;
    readonly fallback?: string;
    readonly states: Readonly<
        Record<
            string,
            {
                readonly answerWaitMs?: number | null;
                readonly emoji?: string;
                readonly prompt?: string;
                readonly title?: string;
            }
        >
    >;
}

/**
 * What every provider serving `models` declares, so the catalog can carry it to a client.
 *
 * A provider that cannot be built — one whose credential is not configured yet — declares
 * nothing rather than a guess, and the catalog simply omits those fields for its models.
 */
export async function readRigProviderCapabilities(
    providers: AgentProviders,
    models: readonly AgentModel[],
): Promise<ReadonlyMap<string, RigProviderCapabilities>> {
    let remembered = declaredModalities.get(providers);
    if (remembered === undefined) {
        remembered = new Map();
        declaredModalities.set(providers, remembered);
    }
    const capabilities = new Map<string, RigProviderCapabilities>();
    for (const providerId of new Set(models.map((model) => model.providerId))) {
        const compatibility = providers.typeOf(providerId);
        if (compatibility === null) continue;
        let answer = remembered.get(providerId);
        if (answer === undefined) {
            const model = models.find((candidate) => candidate.providerId === providerId);
            answer = askProviderForModalities(providers, providerId, model?.id);
            remembered.set(providerId, answer);
        }
        const modalities = await answer;
        capabilities.set(providerId, {
            compatibility,
            ...(modalities ?? { inputTypes: [], outputTypes: [] }),
        });
    }
    return capabilities;
}

export function createRigModelCatalog(
    models: readonly AgentModel[],
    capabilities?: ReadonlyMap<string, RigProviderCapabilities>,
): RigModelCatalog {
    const providerIds = [...new Set(models.map((model) => model.providerId))];
    const first = models[0];
    return {
        defaultModelId: first?.id ?? "",
        defaultProviderId: first?.providerId ?? "",
        models: models.map((model) => projectModel(model, capabilities?.get(model.providerId))),
        providers: providerIds.map((providerId) => {
            const declared = capabilities?.get(providerId);
            const providerModels = models.filter((model) => model.providerId === providerId);
            const serviceTiers = [
                ...new Set(providerModels.flatMap((model) => model.serviceTiers ?? [])),
            ];
            return {
                ...projectCapabilities(declared),
                models: providerModels.map((model) => projectModel(model, declared)),
                providerId,
                ...(serviceTiers.length === 0 ? {} : { serviceTiers }),
            };
        }),
    };
}

export function defaultRigPresence(now = Date.now(), configuration?: RigPresenceConfiguration) {
    const configuredId = configuration?.current ?? configuration?.fallback;
    const configured = configuredId === undefined ? undefined : configuration?.states[configuredId];
    const online = {
        answerWaitMs: configured?.answerWaitMs ?? null,
        emoji: configured?.emoji ?? "🟢",
        id: configuredId ?? "online",
        prompt: configured?.prompt ?? "The user is at the keyboard.",
        title: configured?.title ?? "Online",
    } as const;
    return {
        presence: online,
        presences: [online],
        since: Math.max(0, Math.trunc(now)),
    };
}

async function askProviderForModalities(
    providers: AgentProviders,
    providerId: string,
    modelId: string | undefined,
): Promise<RigProviderModalities | undefined> {
    try {
        const provider = await providers.resolve(providerId, modelId);
        if (provider === null) return undefined;
        return { inputTypes: [...provider.inputTypes], outputTypes: [...provider.outputTypes] };
    } catch {
        return undefined;
    }
}

function projectModel(
    model: AgentModel,
    capabilities: RigProviderCapabilities | undefined,
): RigModelSummary {
    return {
        ...projectCapabilities(capabilities),
        defaultThinkingLevel: model.defaultEffort,
        id: model.id,
        name: model.name,
        thinkingLevels: [...model.effortLevels],
    };
}

function projectCapabilities(
    capabilities: RigProviderCapabilities | undefined,
): Partial<Pick<RigModelSummary, "compatibility" | "inputTypes" | "outputTypes">> {
    if (capabilities === undefined) return {};
    return {
        compatibility: capabilities.compatibility,
        ...(capabilities.inputTypes.length === 0
            ? {}
            : { inputTypes: [...capabilities.inputTypes] }),
        ...(capabilities.outputTypes.length === 0
            ? {}
            : { outputTypes: [...capabilities.outputTypes] }),
    };
}
