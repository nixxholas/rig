import { describe, expect, it } from "vitest";

import { CONTAINER_DOCS_PATH, getBundledDocsRoot } from "./getBundledDocsRoot.js";
import { resolveDockerExecutionConfig } from "./resolveDockerExecutionConfig.js";

describe("resolveDockerExecutionConfig", () => {
    it("resolves relative mount sources and adds the bundled docs mount", () => {
        const resolved = resolveDockerExecutionConfig(
            {
                image: "test:local",
                mounts: [{ source: ".", target: "/workspace" }],
                workingDirectory: "/workspace",
            },
            "/tmp/project",
        );

        expect(resolved.mounts).toEqual([
            { source: "/tmp/project", target: "/workspace" },
            { readOnly: true, source: getBundledDocsRoot(), target: CONTAINER_DOCS_PATH },
        ]);
    });

    it("keeps a user-provided mount at the docs path", () => {
        const resolved = resolveDockerExecutionConfig(
            {
                image: "test:local",
                mounts: [{ source: "/host/docs", target: CONTAINER_DOCS_PATH }],
                workingDirectory: "/workspace",
            },
            "/tmp/project",
        );

        expect(resolved.mounts).toEqual([{ source: "/host/docs", target: CONTAINER_DOCS_PATH }]);
    });

    it("does not add mounts when connecting to an existing container", () => {
        const resolved = resolveDockerExecutionConfig(
            { container: "already-running", workingDirectory: "/repo" },
            "/tmp/project",
        );

        expect(resolved.mounts).toBeUndefined();
    });
});
