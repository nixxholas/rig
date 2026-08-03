/**
 * An authenticated member post the current grant does not accept.
 *
 * This is an ordinary race, not a failure: the owner revokes or stops while a
 * post is already in flight. It is raised as its own type so a share service can
 * drop the post and let Murmur's cursor advance, instead of letting a rejection
 * escape into the shared sync loop and stall every topic behind it.
 */
export class ShareUnauthorizedPostError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ShareUnauthorizedPostError";
    }
}
