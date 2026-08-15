export class AppletNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AppletNotFoundError";
    }
}
