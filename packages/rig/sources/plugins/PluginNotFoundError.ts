export class PluginNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginNotFoundError";
    }
}
