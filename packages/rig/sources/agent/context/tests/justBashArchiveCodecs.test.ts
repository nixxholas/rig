import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

describe("just-bash archive codecs", () => {
    it("reports missing xz and zstd support without crashing the shell", async () => {
        const bash = new Bash({ cwd: "/workspace", files: { "/workspace/a.txt": "hello" } });

        for (const command of ["tar --zstd -cf out.tar.zst a.txt", "tar -J -cf out.tar.xz a.txt"]) {
            const result = await bash.exec(command);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("tar:");
        }

        await expect(bash.exec("echo still-alive")).resolves.toMatchObject({
            exitCode: 0,
            stdout: "still-alive\n",
        });
    });

    it("keeps the codecs that need no native packages working", async () => {
        const bash = new Bash({ cwd: "/workspace", files: { "/workspace/a.txt": "hello" } });

        await expect(bash.exec("tar -cf out.tar a.txt && echo tar-ok")).resolves.toMatchObject({
            exitCode: 0,
            stdout: "tar-ok\n",
        });
        await expect(bash.exec("tar -z -cf out.tgz a.txt && echo gzip-ok")).resolves.toMatchObject({
            exitCode: 0,
            stdout: "gzip-ok\n",
        });
    });
});
