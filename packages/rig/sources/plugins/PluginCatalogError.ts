export type PluginCatalogErrorCode =
    | "catalog_invalid"
    | "catalog_not_found"
    | "invalid_source"
    | "repository_not_found"
    | "source_changed"
    | "source_unavailable";

export class PluginCatalogError extends Error {
    constructor(
        readonly code: PluginCatalogErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "PluginCatalogError";
    }
}
