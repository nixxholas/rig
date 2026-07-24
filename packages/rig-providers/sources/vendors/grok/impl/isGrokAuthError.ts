const AUTH_MESSAGE_PATTERNS = [
    "invalid or expired credentials",
    "no auth context",
    "permissiondenied",
    "unauthorized",
    "invalid api key",
    "invalid authentication",
    "missing credentials",
] as const;

/** Recognizes the upstream rejections that mean the stored credential is no longer usable. */
export function isGrokAuthError(options: { message: string; status?: number }): boolean {
    if (options.status === 401 || options.status === 403) return true;
    const normalized = options.message.toLowerCase();
    return AUTH_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern));
}
