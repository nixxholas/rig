export class PluginBuildError extends Error {
    readonly diagnostics: string;

    constructor(pluginName: string, diagnostics: string) {
        super(`Rig could not build the ${pluginName} plugin.\n${diagnostics}`);
        this.name = "PluginBuildError";
        this.diagnostics = diagnostics;
    }
}
