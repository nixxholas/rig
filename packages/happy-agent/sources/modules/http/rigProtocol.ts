import type { AgentModel } from "@slopus/happy-agent-base";

export const HAPPY_AGENT_RIG_PROTOCOL_VERSION = 17;

export interface RigModelSummary {
    readonly defaultThinkingLevel: string;
    readonly id: string;
    readonly name: string;
    readonly thinkingLevels: readonly string[];
}

export interface RigModelCatalog {
    readonly defaultModelId: string;
    readonly defaultProviderId: string;
    readonly models: readonly RigModelSummary[];
    readonly providers: readonly {
        readonly models: readonly RigModelSummary[];
        readonly providerId: string;
        readonly serviceTiers?: readonly string[];
    }[];
}

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

export function createRigModelCatalog(models: readonly AgentModel[]): RigModelCatalog {
    const projected = models.map(projectModel);
    const providerIds = [...new Set(models.map((model) => model.providerId))];
    const first = models[0];
    return {
        defaultModelId: first?.id ?? "",
        defaultProviderId: first?.providerId ?? "",
        models: projected,
        providers: providerIds.map((providerId) => {
            const providerModels = models.filter((model) => model.providerId === providerId);
            const serviceTiers = [
                ...new Set(providerModels.flatMap((model) => model.serviceTiers ?? [])),
            ];
            return {
                models: providerModels.map(projectModel),
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

function projectModel(model: AgentModel): RigModelSummary {
    return {
        defaultThinkingLevel: model.defaultEffort,
        id: model.id,
        name: model.name,
        thinkingLevels: [...model.effortLevels],
    };
}
