/** Why a scope-share request cannot be carried out, when the caller can fix it. */
export type ScopeShareRequestErrorCode =
    | "already_shared"
    | "invalid_request"
    | "no_murmur_account"
    | "not_shared";

/**
 * A refusal the person asking can act on, rather than a fault in the daemon.
 *
 * Sharing a scope that is already covered, sharing with nobody, or sharing before
 * there is a Murmur account to own the share are all ordinary answers to an
 * ordinary request. Carrying a code lets the daemon API answer 400, 404, or 409
 * instead of reporting every one of them as an internal failure the caller has no
 * way to interpret.
 */
export class ScopeShareRequestError extends Error {
    readonly code: ScopeShareRequestErrorCode;

    constructor(code: ScopeShareRequestErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "ScopeShareRequestError";
    }
}
