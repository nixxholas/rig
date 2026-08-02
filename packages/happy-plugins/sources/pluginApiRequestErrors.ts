import { PluginWorkspaceOperationError } from "./PluginWorkspaceOperationError.js";

export class PluginApiRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginApiRequestError";
    }
}

export class PluginApiRequestTooLargeError extends PluginApiRequestError {
    constructor(message: string) {
        super(message);
        this.name = "PluginApiRequestTooLargeError";
    }
}

export function classifyPluginApiRequestError(error: unknown): 400 | 404 | 413 | 500 {
    if (error instanceof PluginApiRequestTooLargeError) return 413;
    if (error instanceof PluginWorkspaceOperationError) return error.status;
    if (error instanceof PluginApiRequestError) return 400;
    return 500;
}
