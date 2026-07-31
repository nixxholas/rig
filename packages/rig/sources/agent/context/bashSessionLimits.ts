export const MAX_ACTIVE_BASH_SESSIONS = 64;
export const MAX_RETAINED_BASH_SESSIONS = 64;

/**
 * How long a command has to shut itself down before it is forced.
 *
 * A dev server flushing state or a build removing a lock file deserves a
 * moment; two seconds is long enough to be polite and short enough that
 * stopping still feels immediate.
 */
export const BASH_SESSION_STOP_GRACE_MS = 2_000;
