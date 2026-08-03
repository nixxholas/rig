export type PluginCatalogErrorCode =
    | "catalog_invalid"
    | "catalog_not_found"
    | "invalid_source"
    | "repository_not_found"
    | "source_changed"
    | "source_unavailable";

export class PluginCatalogError extends Error {
    // Assigned rather than declared as a constructor parameter property: the gym runs
    // Rig through Node's strip-only TypeScript, which refuses that syntax outright and
    // takes every end-to-end scenario down with it.
    readonly code: PluginCatalogErrorCode;

    constructor(code: PluginCatalogErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "PluginCatalogError";
    }
}
