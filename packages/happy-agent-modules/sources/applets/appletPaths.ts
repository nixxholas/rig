import { homedir } from "node:os";

/**
 * The user-visible folder installed applets live in. Each applet is one
 * kebab-case-named folder of static files inside it, holding its icon files and
 * one `v<n>` directory per imported version.
 *
 * This is the default install root; a host may override it with the
 * `rootDirectory` module option.
 */
export function defaultAppletsRootDirectory(
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    return platform === "darwin"
        ? `${homeDirectory}/Happy/Applets`
        : `${homeDirectory}/happy/applets`;
}

/** The stable HTTP path a host serves an applet's identity icon from. */
export function appletIconUrl(name: string): string {
    return `/applets/${encodeURIComponent(name)}/favicon.png`;
}
