import { describe, expect, it, vi } from "vitest";

import { createSandboxConfigDirectoryCache } from "../../../sources/sandbox/impl/createSandboxConfigDirectoryCache.js";

describe("createSandboxConfigDirectoryCache", () => {
    it("retries after directory creation fails", async () => {
        const createDirectory = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error("temporary failure"))
            .mockResolvedValueOnce("/tmp/agent-compute-sandbox-recovered");
        const getDirectory = createSandboxConfigDirectoryCache(createDirectory);

        await expect(getDirectory()).rejects.toThrow("temporary failure");
        await expect(getDirectory()).resolves.toBe("/tmp/agent-compute-sandbox-recovered");
        expect(createDirectory).toHaveBeenCalledTimes(2);
    });
});
