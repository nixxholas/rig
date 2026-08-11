export interface ResolveGlobalDevelopmentIdentityVersionOptions {
    readonly currentSourceVersion: string;
    readonly readInstalledVersion: () => Promise<string | undefined>;
    readonly readRunningVersion: () => Promise<string | undefined>;
}

/**
 * Global development shares the production socket with installed Rig clients. It therefore has
 * to present the production identity those clients already trust, even while its implementation
 * comes from the current checkout.
 */
export async function resolveGlobalDevelopmentIdentityVersion(
    options: ResolveGlobalDevelopmentIdentityVersionOptions,
): Promise<string> {
    return (
        normalizeVersion(await options.readRunningVersion()) ??
        normalizeVersion(await options.readInstalledVersion()) ??
        options.currentSourceVersion
    );
}

function normalizeVersion(version: string | undefined): string | undefined {
    const normalized = version?.trim();
    return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
