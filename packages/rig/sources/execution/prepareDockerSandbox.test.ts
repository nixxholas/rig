import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { prepareDockerSandbox } from "./prepareDockerSandbox.js";

describe("prepareDockerSandbox", () => {
    it("probes the same private procfs shape used by restricted commands", async () => {
        const run = vi.fn();
        run.mockResolvedValueOnce({
            exitCode: 0,
            stderr: Buffer.alloc(0),
            stdout: Buffer.from("/usr/bin/bwrap\n"),
        }).mockResolvedValueOnce({
            exitCode: 0,
            stderr: Buffer.alloc(0),
            stdout: Buffer.alloc(0),
        });

        await prepareDockerSandbox({} as Dockerode.Container, { run });

        const probe = run.mock.calls[1]?.[1] as readonly string[];
        const temporaryIndex = probe.indexOf("/tmp");
        expect(probe.slice(temporaryIndex - 1, temporaryIndex + 1)).toEqual(["--tmpfs", "/tmp"]);
        const procIndex = probe.indexOf("/proc");
        expect(probe.slice(procIndex - 1, procIndex + 1)).toEqual(["--tmpfs", "/proc"]);
        expect(probe).not.toContain("--bind");
    });
});
