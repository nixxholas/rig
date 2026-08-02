export class PluginWorkspaceOperationError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 = 400,
        cause?: unknown,
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "PluginWorkspaceOperationError";
    }
}
