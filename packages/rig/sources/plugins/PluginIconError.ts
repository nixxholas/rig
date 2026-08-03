export type PluginIconErrorCode = "icon_unavailable" | "plugin_not_found" | "stale_generation";

/** A stable failure from the generation-bound catalog icon capability. */
export class PluginIconError extends Error {
    readonly code: PluginIconErrorCode;

    constructor(code: PluginIconErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "PluginIconError";
    }
}
