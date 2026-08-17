import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
    AUTO_SECURITY_MD_MAX_BYTES,
    boundSecurityFileText,
    isMissingSecurityFileError,
    readAutoSecurityPolicy,
} from "../../sources/auto/impl/readAutoSecurityPolicy.js";

describe("readAutoSecurityPolicy", () => {
    it("joins both files under the exact v1 headings", async () => {
        const policy = await readAutoSecurityPolicy({
            readGlobalSecurity: async () => "Global rule.",
            readProjectSecurity: async () => "Project rule.",
        });

        expect(policy).toBe(
            "## Global SECURITY.md\n\nGlobal rule.\n\n## Project AGENTS_SECURITY.md\n\nProject rule.",
        );
    });

    it("omits the heading of an absent file", async () => {
        expect(
            await readAutoSecurityPolicy({
                readGlobalSecurity: async () => undefined,
                readProjectSecurity: async () => "Project rule.",
            }),
        ).toBe("## Project AGENTS_SECURITY.md\n\nProject rule.");

        expect(
            await readAutoSecurityPolicy({
                readGlobalSecurity: async () => "Global rule.",
                readProjectSecurity: async () => undefined,
            }),
        ).toBe("## Global SECURITY.md\n\nGlobal rule.");
    });

    it("returns undefined when neither file is present", async () => {
        expect(
            await readAutoSecurityPolicy({
                readGlobalSecurity: async () => undefined,
                readProjectSecurity: async () => undefined,
            }),
        ).toBeUndefined();
    });

    it("propagates a reader failure so the caller can make the review unavailable", async () => {
        await expect(
            readAutoSecurityPolicy({
                readGlobalSecurity: async () => {
                    throw new Error("disk error");
                },
                readProjectSecurity: async () => undefined,
            }),
        ).rejects.toThrow("disk error");
    });

    it("bounds a file to 32 KiB and drops blank content", () => {
        expect(boundSecurityFileText(Buffer.from("   \n\t "))).toBeUndefined();
        expect(boundSecurityFileText(Buffer.from("keep this"))).toBe("keep this");

        const large = Buffer.from("a".repeat(AUTO_SECURITY_MD_MAX_BYTES + 500));
        expect(boundSecurityFileText(large)).toHaveLength(AUTO_SECURITY_MD_MAX_BYTES);
    });

    it("classifies missing-file errors as absent, and other errors as genuine", () => {
        for (const code of ["ENOENT", "ENOTDIR", "EISDIR"]) {
            expect(isMissingSecurityFileError(Object.assign(new Error(code), { code }))).toBe(true);
        }
        expect(
            isMissingSecurityFileError(Object.assign(new Error("EACCES"), { code: "EACCES" })),
        ).toBe(false);
        expect(isMissingSecurityFileError(new Error("no code"))).toBe(false);
    });

    it("reads both policies concurrently", async () => {
        let globalStarted = false;
        let projectStarted = false;
        let release!: () => void;
        const bothStarted = new Promise<void>((resolve) => {
            release = resolve;
        });

        const policy = readAutoSecurityPolicy({
            readGlobalSecurity: async () => {
                globalStarted = true;
                if (projectStarted) release();
                await bothStarted;
                return "global";
            },
            readProjectSecurity: async () => {
                projectStarted = true;
                if (globalStarted) release();
                await bothStarted;
                return "project";
            },
        });

        await expect(policy).resolves.toContain("global");
        expect(globalStarted).toBe(true);
        expect(projectStarted).toBe(true);
    });

    it("handles byte-oriented limits and never mutates the source bytes", () => {
        const original = Buffer.from(`prefix-${"x".repeat(AUTO_SECURITY_MD_MAX_BYTES)}`);
        const before = Buffer.from(original);
        const bounded = boundSecurityFileText(original);

        expect(bounded).toHaveLength(AUTO_SECURITY_MD_MAX_BYTES);
        expect(original).toEqual(before);
        expect(boundSecurityFileText(new Uint8Array())).toBeUndefined();
    });

    it("decodes a truncated multibyte boundary without exceeding the byte budget", () => {
        const bytes = Buffer.alloc(AUTO_SECURITY_MD_MAX_BYTES + 2, 0x61);
        bytes.set(Buffer.from("€"), AUTO_SECURITY_MD_MAX_BYTES - 1);

        const bounded = boundSecurityFileText(bytes);

        expect(bounded).toBeDefined();
        expect(Buffer.byteLength(bounded ?? "", "utf8")).toBeLessThanOrEqual(
            AUTO_SECURITY_MD_MAX_BYTES + 2,
        );
    });
});
