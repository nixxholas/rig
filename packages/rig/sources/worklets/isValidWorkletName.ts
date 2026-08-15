const WORKLET_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/** A worklet is named with a human-readable kebab-case name, which is also its folder name. */
export function isValidWorkletName(name: string): boolean {
    return WORKLET_NAME_PATTERN.test(name);
}
