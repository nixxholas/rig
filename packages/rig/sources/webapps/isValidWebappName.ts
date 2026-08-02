const WEBAPP_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/** A webapp is named with a human-readable kebab-case name, which is also its folder name. */
export function isValidWebappName(name: string): boolean {
    return WEBAPP_NAME_PATTERN.test(name);
}
