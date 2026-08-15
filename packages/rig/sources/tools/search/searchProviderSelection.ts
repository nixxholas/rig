import { Type } from "@sinclair/typebox";

import type { OneOffInferenceRoute, SearchProviderRoutes } from "./OneOffInferenceRoute.js";

/**
 * Which account a vendor search runs on, and how that choice is described to the model.
 *
 * A person can have several accounts with one vendor, and only the session's own account is known
 * to be signed in and paid for. Choosing between them is Rig's job, so the default is always the
 * session's account; the argument stays available for a person who asks for a different one by
 * name. The model was previously told which accounts exist without being told which one it would
 * get for free, so it volunteered a name and reached for accounts that were signed out.
 */
export interface SearchProviderSelection {
    /** Closing line of the tool description, naming the accounts and the default. */
    availability: string;
    providerIdIsOptional: boolean;
    providerIdSchema: ReturnType<typeof Type.String>;
    selectRoute: (requestedProviderId: string | undefined) => OneOffInferenceRoute;
}

export function searchProviderSelection(
    vendor: string,
    options: SearchProviderRoutes,
): SearchProviderSelection {
    const providerIds = [...new Set(options.routes.map((route) => route.provider.id))];
    if (providerIds.length === 0) {
        throw new Error(`${vendor} search requires at least one configured provider.`);
    }
    const available = providerIds.join(", ");
    const defaultProviderId =
        options.currentProviderId !== undefined && providerIds.includes(options.currentProviderId)
            ? options.currentProviderId
            : providerIds.length === 1
              ? providerIds[0]
              : undefined;
    return {
        availability:
            defaultProviderId === undefined
                ? `Available ${vendor} provider IDs: ${available}. Name one in provider_id.`
                : `Available ${vendor} provider IDs: ${available}. Leave provider_id out to search from this chat's own account, ${defaultProviderId}; name another account only when the user asks for one.`,
        providerIdIsOptional: defaultProviderId !== undefined,
        providerIdSchema: Type.String({
            description:
                defaultProviderId === undefined
                    ? `${vendor} account to search from. Available provider IDs: ${available}`
                    : `${vendor} account to search from. Defaults to this chat's own account, ${defaultProviderId}. Set this only when the user asks for a specific account. Available provider IDs: ${available}`,
            enum: providerIds,
        }),
        selectRoute: (requestedProviderId) => {
            const selectedProviderId = requestedProviderId ?? defaultProviderId;
            if (selectedProviderId === undefined) {
                throw new Error(
                    `${vendor} search requires provider_id. Available provider IDs: ${available}.`,
                );
            }
            const route = options.routes.find(
                (candidate) => candidate.provider.id === selectedProviderId,
            );
            if (route === undefined) {
                throw new Error(
                    `Unknown ${vendor} provider '${selectedProviderId}'. Available provider IDs: ${available}.`,
                );
            }
            return route;
        },
    };
}
