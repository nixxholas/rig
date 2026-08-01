export class ExtensionBuildError extends Error {
    readonly diagnostics: string;

    constructor(extensionName: string, diagnostics: string) {
        super(`Rig could not build the ${extensionName} extension.\n${diagnostics}`);
        this.name = "ExtensionBuildError";
        this.diagnostics = diagnostics;
    }
}
