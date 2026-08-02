import { describe, expect, it } from "vitest";

import { runBundledMediaCommand } from "./runBundledMediaCommand.js";

describe("runBundledMediaCommand", () => {
    it.each(["ffmpeg", "ffprobe"] as const)(
        "runs Rig's bundled %s executable",
        async (executable) => {
            const result = await runBundledMediaCommand({
                arguments: ["-version"],
                executable,
                timeoutMs: 5_000,
            });

            expect(result).toMatchObject({ exitCode: 0, timedOut: false });
            expect(result.stdout.toLowerCase()).toContain(`${executable} version`);
        },
    );
});
