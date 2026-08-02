export class SlotEntryNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SlotEntryNotFoundError";
    }
}
