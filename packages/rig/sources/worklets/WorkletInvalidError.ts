/** A worklet request was rejected: bad name, missing source folder, or an unknown version. */
export class WorkletInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkletInvalidError";
    }
}
