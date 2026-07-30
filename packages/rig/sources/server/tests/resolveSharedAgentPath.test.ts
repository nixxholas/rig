import { describe, expect, it } from "vitest";

import { resolveSharedAgentPath } from "../resolveSharedAgentPath.js";

describe("resolveSharedAgentPath", () => {
    it("returns a usable path for local sessions and shared containers", () => {
        expect(
            resolveSharedAgentPath(
                { cwd: "/work/one", sessionId: "one" },
                { cwd: "/work/two", sessionId: "two" },
            ),
        ).toBe("/work/two");
        expect(
            resolveSharedAgentPath(
                {
                    cwd: "/host/one",
                    docker: { container: "shared", workingDirectory: "/work/one" },
                    sessionId: "one",
                },
                {
                    cwd: "/host/two",
                    docker: { container: "shared", workingDirectory: "/work/two" },
                    sessionId: "two",
                },
            ),
        ).toBe("/work/two");
    });

    it("translates a shared bind mount and rejects separate container disks", () => {
        expect(
            resolveSharedAgentPath(
                {
                    cwd: "/host/one",
                    docker: {
                        image: "agent",
                        mounts: [{ source: "/host/shared", target: "/sender" }],
                        workingDirectory: "/sender/one",
                    },
                    sessionId: "one",
                },
                {
                    cwd: "/host/two",
                    docker: {
                        image: "agent",
                        mounts: [{ source: "/host/shared", target: "/target" }],
                        workingDirectory: "/target/two",
                    },
                    sessionId: "two",
                },
            ),
        ).toBe("/sender/two");
        expect(
            resolveSharedAgentPath(
                {
                    cwd: "/host/one",
                    docker: { image: "agent", workingDirectory: "/workspace" },
                    sessionId: "one",
                },
                {
                    cwd: "/host/two",
                    docker: { image: "agent", workingDirectory: "/workspace" },
                    sessionId: "two",
                },
            ),
        ).toBeUndefined();
    });
});
