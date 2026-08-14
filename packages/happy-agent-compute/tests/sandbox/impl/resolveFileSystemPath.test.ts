import { describe, expect, it } from "vitest";

import { resolveFileSystemPath } from "../../../sources/sandbox/impl/resolveFileSystemPath.js";

describe("resolveFileSystemPath", () => {
    it("resolves relative, absolute, and home-relative paths consistently", () => {
        expect(resolveFileSystemPath("src/index.ts", "/workspace", "/home/user")).toBe(
            "/workspace/src/index.ts",
        );
        expect(resolveFileSystemPath("/tmp/input.txt", "/workspace", "/home/user")).toBe(
            "/tmp/input.txt",
        );
        expect(resolveFileSystemPath("~", "/workspace", "/home/user")).toBe("/home/user");
        expect(resolveFileSystemPath("~/input.txt", "/workspace", "/home/user")).toBe(
            "/home/user/input.txt",
        );
    });

    it("rejects home-relative paths when the execution environment has no home", () => {
        expect(() => resolveFileSystemPath("~/input.txt", "/workspace")).toThrow(
            "home-relative paths are unavailable",
        );
    });
});
