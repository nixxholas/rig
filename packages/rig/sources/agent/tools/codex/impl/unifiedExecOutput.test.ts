import { describe, expect, it } from "vitest";

import type { BashSessionSnapshot } from "../../../context/BashContext.js";
import { createUnifiedExecOutput } from "./unifiedExecOutput.js";

describe("createUnifiedExecOutput", () => {
    it("reports the complete byte count when the capture omitted output", () => {
        const snapshot: BashSessionSnapshot = {
            command: "emit output",
            cwd: "/workspace",
            exitCode: 0,
            sessionId: 1,
            status: "completed",
            stderr: "",
            stderrDelta: "",
            stdout: "HEAD\n... 4 bytes omitted ...\nTAIL",
            stdoutDelta: "HEAD\n... 4 bytes omitted ...\nTAIL",
            stdoutDeltaBytes: 20,
            stdoutDeltaOmittedBytes: 4,
            stdoutBytes: 20,
            stdoutOmittedBytes: 4,
            timedOut: false,
        };

        const result = createUnifiedExecOutput(snapshot, 0.25);

        expect(result.original_token_count).toBe(5);
        expect(result.output).toContain("... 4 bytes omitted ...");
        expect(result.output).toContain("HEAD");
        expect(result.output).toContain("TAIL");
        expect(result.output.match(/bytes omitted/gu)).toHaveLength(1);
    });

    it("preserves user output that exactly matches the synthetic omission marker", () => {
        const output = "USER\n... 4 bytes omitted ...\nHEAD\n... 4 bytes omitted ...\nTAIL";
        const snapshot: BashSessionSnapshot = {
            command: "emit marker",
            cwd: "/workspace",
            exitCode: 0,
            sessionId: 1,
            status: "completed",
            stderr: "",
            stderrDelta: "",
            stdout: output,
            stdoutDelta: output,
            stdoutDeltaBytes: 72,
            stdoutDeltaOmittedBytes: 4,
            stdoutBytes: 72,
            stdoutOmittedBytes: 4,
            timedOut: false,
        };

        const result = createUnifiedExecOutput(snapshot, 0.25);

        expect(result.output).toBe(output);
        expect(result.output.match(/bytes omitted/gu)).toHaveLength(2);
    });
});
