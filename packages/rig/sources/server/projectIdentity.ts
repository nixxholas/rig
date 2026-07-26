import { basename } from "node:path";

import { deunicode } from "deunicode";

export function projectNameKey(name: string): string {
    return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function validateProjectName(value: string): string {
    const name = value.trim();
    if (name.length === 0) throw new Error("Project name cannot be empty.");
    if ([...name].length > 100) {
        throw new Error("Project name cannot be longer than 100 characters.");
    }
    if (/[\p{Cc}\p{Cf}]/u.test(name)) {
        throw new Error("Project name cannot contain control characters.");
    }
    return name;
}

export function folderProjectName(path: string): string {
    const candidate = basename(path).trim();
    return candidate.length === 0 ? "Project" : candidate;
}

export function projectStorageKey(value: string): string {
    const readable = deunicode(transliterateCyrillic(value))
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 48)
        .replace(/-+$/gu, "");
    return readable.length === 0 ? "project" : readable;
}

function transliterateCyrillic(value: string): string {
    const replacements: Record<string, string> = {
        а: "a",
        б: "b",
        в: "v",
        г: "g",
        д: "d",
        е: "e",
        ё: "yo",
        ж: "zh",
        з: "z",
        и: "i",
        й: "y",
        к: "k",
        л: "l",
        м: "m",
        н: "n",
        о: "o",
        п: "p",
        р: "r",
        с: "s",
        т: "t",
        у: "u",
        ф: "f",
        х: "h",
        ц: "ts",
        ч: "ch",
        ш: "sh",
        щ: "sch",
        ъ: "",
        ы: "y",
        ь: "",
        э: "e",
        ю: "yu",
        я: "ya",
    };
    return [...value]
        .map((character) => {
            const lower = character.toLocaleLowerCase("ru-RU");
            const replacement = replacements[lower];
            if (replacement === undefined) return character;
            return character === lower
                ? replacement
                : replacement.charAt(0).toLocaleUpperCase("en-US") + replacement.slice(1);
        })
        .join("");
}

export function remoteProjectName(remote: string): string | undefined {
    const trimmed = remote.trim();
    if (trimmed.length === 0 || trimmed.startsWith("/") || trimmed.startsWith("./")) {
        return undefined;
    }
    let path: string;
    try {
        if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
            const url = new URL(trimmed);
            if (url.protocol !== "https:" && url.protocol !== "ssh:") return undefined;
            path = url.pathname;
        } else {
            const scp = /^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/u.exec(trimmed);
            if (scp === null) return undefined;
            path = scp[1] ?? "";
        }
        const encoded = path.split("/").filter(Boolean).at(-1);
        if (encoded === undefined) return undefined;
        const decoded = decodeURIComponent(encoded)
            .replace(/\.git$/iu, "")
            .trim();
        return decoded.length === 0 ? undefined : decoded;
    } catch {
        return undefined;
    }
}

export interface HostingRepository {
    host: "bitbucket.org" | "github.com" | "gitlab.com";
    owner: string;
    repository: string;
}

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
