/** A webapp request was rejected: bad name, missing source folder, or an unknown version. */
export class WebappInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebappInvalidError";
    }
}
