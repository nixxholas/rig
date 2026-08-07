/** An applet request was rejected: bad name, missing source folder, or an unknown version. */
export class AppletInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AppletInvalidError";
    }
}
