import { describe, expect, it } from "vitest";

import {
    desktopApplicationEntrypoint,
    desktopBuilderConfiguration,
    desktopLoginShell,
    desktopRigLauncher,
} from "./desktopApplicationRuntime.js";

describe("Happy desktop packaging", () => {
    it("boots Happy with the bundled Rig command ahead of the login-shell environment", () => {
        expect(desktopApplicationEntrypoint()).toContain(
            'join(process.resourcesPath, "rig-runtime", "bin")',
        );
        expect(desktopApplicationEntrypoint()).toContain(
            'process.env.SHELL = join(runtimeBin, "happy2-login-shell")',
        );
        expect(desktopLoginShell()).toContain('export PATH="$1:$PATH"');
    });

    it("runs the bundled Rig through the packaged Electron executable", () => {
        const launcher = desktopRigLauncher();

        expect(launcher).toContain("export ELECTRON_RUN_AS_NODE=1");
        expect(launcher).toContain('MacOS/Happy Nightly"');
        expect(launcher).toContain('"$bin_directory/../dist/main.js"');
    });

    it("packages the Happy local shell and complete Rig runtime", () => {
        expect(
            desktopBuilderConfiguration({
                buildResources: "/happy2/build",
                happy2NodeModules: "/staging/happy2/node_modules",
                output: "/staging/release",
                rigRuntime: "/staging/rig-runtime",
            }),
        ).toMatchObject({
            appId: "com.slopus.happy2.nightly",
            directories: { output: "/staging/release" },
            executableName: "Happy Nightly",
            extraResources: [
                { from: "/staging/happy2/node_modules", to: "node_modules" },
                { from: "/staging/rig-runtime", to: "rig-runtime" },
                {
                    from: "/staging/rig-runtime/node_modules",
                    to: "rig-runtime/node_modules",
                },
            ],
            files: ["dist/main.js", "dist/preload.cjs", "rig-main.mjs", "package.json"],
            productName: "Happy Nightly",
        });
    });
});
