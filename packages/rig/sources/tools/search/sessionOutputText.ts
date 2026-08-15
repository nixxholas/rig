import type { SessionOutputBlock } from "@slopus/happy-providers";

export function sessionOutputText(content: readonly SessionOutputBlock[]): string {
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}
