import type { ExecutorModelProfile, ExecutorProvider } from "@slopus/rig-execution";

/** A configured provider and model used for one bounded inference call. */
export interface OneOffInferenceRoute {
    profile: ExecutorModelProfile;
    provider: ExecutorProvider;
}

export interface SearchInferenceRoutes {
    bedrockRoutes: readonly OneOffInferenceRoute[];
    claudeRoutes: readonly OneOffInferenceRoute[];
    codexRoutes: readonly OneOffInferenceRoute[];
    grokRoutes: readonly OneOffInferenceRoute[];
}

export interface SearchProviderRoutes {
    currentProviderId?: string;
    routes: readonly OneOffInferenceRoute[];
}
