import { Type } from "@sinclair/typebox";

import type { OneOffInferenceRoute, SearchProviderRoutes } from "./OneOffInferenceRoute.js";

export function grokProviderIds(options: SearchProviderRoutes): string[] {
    const providerIds = [...new Set(options.routes.map((route) => route.provider.id))];
    if (providerIds.length === 0) {
        throw new Error("Grok search requires at least one configured provider.");
    }
    return providerIds;
}

export function grokProviderIdSchema(options: SearchProviderRoutes) {
    const providerIds = grokProviderIds(options);
    return Type.String({
        description: `Grok provider to use. Available provider IDs: ${providerIds.join(", ")}`,
        enum: providerIds,
    });
}

export function grokProviderIdIsOptional(options: SearchProviderRoutes): boolean {
    const providerIds = grokProviderIds(options);
    return (
        providerIds.length === 1 ||
        (options.currentProviderId !== undefined && providerIds.includes(options.currentProviderId))
    );
}

export function selectGrokRoute(
    options: SearchProviderRoutes,
    requestedProviderId: string | undefined,
): OneOffInferenceRoute {
    const providerIds = grokProviderIds(options);
    const selectedProviderId =
        requestedProviderId ??
        (options.currentProviderId !== undefined && providerIds.includes(options.currentProviderId)
            ? options.currentProviderId
            : options.routes.length === 1
              ? options.routes[0]?.provider.id
              : undefined);
    if (selectedProviderId === undefined) {
        throw new Error(
            `Grok search requires provider_id. Available provider IDs: ${providerIds.join(", ")}.`,
        );
    }
    const route = options.routes.find((candidate) => candidate.provider.id === selectedProviderId);
    if (route === undefined) {
        throw new Error(
            `Unknown Grok provider '${selectedProviderId}'. Available provider IDs: ${providerIds.join(", ")}.`,
        );
    }
    return route;
}
