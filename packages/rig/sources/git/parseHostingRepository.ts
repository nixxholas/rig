/** A repository identified on one of the forges Rig knows how to ask for an avatar. */
export interface HostingRepository {
    host: "bitbucket.org" | "github.com" | "gitlab.com";
    owner: string;
    repository: string;
}

/**
 * Recognizes a remote hosted by one of those three forges, in both the URL and the SCP-like
 * spelling. Every path segment is validated so a crafted remote cannot escape into a different
 * request path.
 */
export function parseHostingRepository(remote: string): HostingRepository | undefined {
    let host: string;
    let path: string;
    try {
        if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)) {
            const url = new URL(remote);
            host = url.hostname.toLocaleLowerCase("en-US");
            path = url.pathname;
        } else {
            const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(remote);
            if (match === null) return undefined;
            host = (match[1] ?? "").toLocaleLowerCase("en-US");
            path = match[2] ?? "";
        }
        if (host !== "github.com" && host !== "gitlab.com" && host !== "bitbucket.org") {
            return undefined;
        }
        const parts = path
            .replace(/^\/+/u, "")
            .replace(/\.git$/iu, "")
            .split("/")
            .map((part) => decodeURIComponent(part));
        if (parts.length < 2) return undefined;
        if (host !== "gitlab.com" && parts.length !== 2) return undefined;
        const owner = parts.slice(0, -1).join("/");
        const repository = parts.at(-1) ?? "";
        const validSegment = /^[A-Za-z0-9_.-]{1,100}$/u;
        if (
            owner
                .split("/")
                .some((part) => !validSegment.test(part) || part === "." || part === "..") ||
            !validSegment.test(repository) ||
            repository === "." ||
            repository === ".."
        ) {
            return undefined;
        }
        return { host, owner, repository };
    } catch {
        return undefined;
    }
}
