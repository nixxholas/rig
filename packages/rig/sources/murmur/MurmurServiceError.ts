export type MurmurServiceErrorCode =
    | "account_exists"
    | "account_missing"
    | "service_not_running"
    | "request_not_found"
    | "invalid_identity_token"
    | "invalid_profile"
    | "relay_unavailable";

/** Stable domain error consumed by the Murmur HTTP adapter. */
export class MurmurServiceError extends Error {
    readonly code: MurmurServiceErrorCode;

    constructor(code: MurmurServiceErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
        this.name = "MurmurServiceError";
    }
}
