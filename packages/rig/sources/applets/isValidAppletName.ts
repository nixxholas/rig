const APPLET_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/** An applet is named with a human-readable kebab-case name, which is also its folder name. */
export function isValidAppletName(name: string): boolean {
    return APPLET_NAME_PATTERN.test(name);
}
