export class WorkletNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkletNotFoundError";
    }
}
