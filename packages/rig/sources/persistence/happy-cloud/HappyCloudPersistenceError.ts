export type HappyCloudPersistenceErrorCode =
    | "capability_not_granted"
    | "not_enrolled"
    | "mutation_reused"
    | "version_conflict";

export class HappyCloudPersistenceError extends Error {
    readonly code: HappyCloudPersistenceErrorCode;

    constructor(code: HappyCloudPersistenceErrorCode, message: string) {
        super(message);
        this.name = "HappyCloudPersistenceError";
        this.code = code;
    }
}
