import { join } from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("rig-connect browser bundle", () => {
    it("bundles the public entry for a browser without Node built-ins or plugin runtime code", async () => {
        const result = await build({
            bundle: true,
            entryPoints: [join(process.cwd(), "sources", "index.ts")],
            format: "esm",
            logLevel: "silent",
            platform: "browser",
            sourcemap: false,
            write: false,
        });
        const bundle = result.outputFiles.map((file) => file.text).join("\n");
        expect(bundle.length).toBeGreaterThan(0);
        expect(bundle).not.toContain("node:");
        expect(bundle).not.toContain("happy-plugins");
        expect(bundle).not.toContain("HAPPY_PLUGIN_SOCKET_PATH");
        expect(bundle).toContain("discoverRigInstallation");
        expect(bundle).toContain("resolveRigOnboarding");
    });
});
