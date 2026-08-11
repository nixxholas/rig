import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

import { createJustBashFileSystemContext } from "../createJustBashFileSystemContext.js";

describe("createJustBashFileSystemContext", () => {
    it("pages its in-memory directory listing in UTF-8 byte order", async () => {
        const bash = new Bash({
            cwd: "/workspace",
            files: {
                "/workspace/zeta": "",
                "/workspace/.context": "",
                "/workspace/alpha": "",
                "/workspace/middle": "",
                "/workspace/éclair": "",
            },
        });
        const context = createJustBashFileSystemContext(bash, "/workspace");

        await expect(context.readdirPage("/workspace", { limit: 2 })).resolves.toEqual({
            entries: [".context", "alpha"],
            hasMore: true,
        });
        await expect(
            context.readdirPage("/workspace", { after: "alpha", limit: 3 }),
        ).resolves.toEqual({
            entries: ["middle", "zeta", "éclair"],
            hasMore: false,
        });
    });
});
