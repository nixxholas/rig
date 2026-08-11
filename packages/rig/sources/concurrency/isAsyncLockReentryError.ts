/** Recognizes stdlib's blocked-reentry programming error at recovery boundaries. */
export function isAsyncLockReentryError(error: unknown): error is Error {
    return error instanceof Error && error.message === "AsyncLock reentry is blocked";
}
