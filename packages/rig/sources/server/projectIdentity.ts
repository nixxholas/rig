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
