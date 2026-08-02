/** A slot entry was rejected because its slot, scope, content, or scope reference is invalid. */
export class SlotEntryInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SlotEntryInvalidError";
    }
}
