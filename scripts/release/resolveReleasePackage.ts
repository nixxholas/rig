import { fileURLToPath } from "node:url";

import type { ReleasePackage, ReleasePackageKey } from "./ReleasePackage.js";

const PACKAGES: Record<ReleasePackageKey, ReleasePackage> = {
    "happy-plugins": {
        buildArguments: ["--filter", "happy-plugins", "build"],
        commitPrefix: "Release happy-plugins v",
        directory: fileURLToPath(new URL("../../packages/happy-plugins/", import.meta.url)),
        key: "happy-plugins",
        manifestPath: "packages/happy-plugins/package.json",
        tagPrefix: "happy-plugins-v",
    },
    rig: {
        buildArguments: ["run", "build"],
        commitPrefix: "Release v",
        directory: fileURLToPath(new URL("../../packages/rig/", import.meta.url)),
        key: "rig",
        manifestPath: "packages/rig/package.json",
        tagPrefix: "v",
    },
    "rig-connect": {
        buildArguments: ["--filter", "@slopus/rig-connect", "build"],
        commitPrefix: "Release rig-connect v",
        directory: fileURLToPath(new URL("../../packages/rig-connect/", import.meta.url)),
        key: "rig-connect",
        manifestPath: "packages/rig-connect/package.json",
        tagPrefix: "rig-connect-v",
    },
};

export function resolveReleasePackage(value: string | undefined): ReleasePackage {
    const key = value ?? "rig";
    if (key !== "rig" && key !== "rig-connect" && key !== "happy-plugins") {
        throw new Error(
            `Unknown release package ${key}. Expected rig, rig-connect, or happy-plugins.`,
        );
    }
    return PACKAGES[key];
}
