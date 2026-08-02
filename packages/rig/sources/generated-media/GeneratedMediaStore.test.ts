import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGeneratedMediaStore } from "./GeneratedMediaStore.js";

describe("createGeneratedMediaStore", () => {
    it("writes publicly readable media and returns the model-visible path", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-generated-"));
        const store = createGeneratedMediaStore({
            hostDirectory: join(root, "Generated"),
            modelDirectory: "/happy/generated",
        });

        const result = await store.write(Buffer.from("preview"), {
            extension: ".png",
            preferredName: "First frame",
        });

        expect(result.location).toMatch(/^generated\/First-frame-[a-f0-9]{8}\.png$/u);
        expect(result.path).toMatch(/^\/happy\/generated\/First-frame-[a-f0-9]{8}\.png$/u);
        expect(await readFile(result.hostPath, "utf8")).toBe("preview");
        expect((await stat(result.hostPath)).mode & 0o777).toBe(0o644);
        expect((await stat(store.hostDirectory)).mode & 0o777).toBe(0o755);
    });
});
