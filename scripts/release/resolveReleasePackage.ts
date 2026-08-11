import { fileURLToPath } from "node:url";

import type { ReleasePackage, ReleasePackageKey } from "./ReleasePackage.js";

const PACKAGES: Record<ReleasePackageKey, ReleasePackage> = {
    "happy-agent-base": {
        buildArguments: ["--filter", "@slopus/happy-agent-base", "build"],
        checkArguments: ["--filter", "@slopus/happy-agent-base", "check"],
        commitPrefix: "Release happy-agent-base v",
        directory: fileURLToPath(new URL("../../packages/happy-agent-base/", import.meta.url)),
        key: "happy-agent-base",
        manifestPath: "packages/happy-agent-base/package.json",
        tagPrefix: "happy-agent-base-v",
        testArguments: [["--filter", "@slopus/happy-agent-base", "test"]],
    },
    "happy-providers": {
        buildArguments: ["--filter", "@slopus/happy-providers", "build"],
        checkArguments: ["--filter", "@slopus/happy-providers", "check"],
        commitPrefix: "Release happy-providers v",
        directory: fileURLToPath(new URL("../../packages/happy-providers/", import.meta.url)),
        key: "happy-providers",
        manifestPath: "packages/happy-providers/package.json",
        tagPrefix: "happy-providers-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "@slopus/happy-providers", "test"],
        ],
    },
    "happy-plugins": {
        buildArguments: ["--filter", "happy-plugins", "build"],
        checkArguments: ["--filter", "happy-plugins", "check"],
        commitPrefix: "Release happy-plugins v",
        directory: fileURLToPath(new URL("../../packages/happy-plugins/", import.meta.url)),
        key: "happy-plugins",
        manifestPath: "packages/happy-plugins/package.json",
        tagPrefix: "happy-plugins-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "happy-plugins", "test"],
        ],
    },
    rig: {
        buildArguments: ["run", "build"],
        checkArguments: ["run", "check"],
        commitPrefix: "Release v",
        directory: fileURLToPath(new URL("../../packages/rig/", import.meta.url)),
        key: "rig",
        manifestPath: "packages/rig/package.json",
        tagPrefix: "v",
        testArguments: [["run", "test:release"]],
    },
    "rig-connect": {
        buildArguments: ["--filter", "@slopus/rig-connect", "build"],
        checkArguments: ["--filter", "@slopus/rig-connect", "check"],
        commitPrefix: "Release rig-connect v",
        directory: fileURLToPath(new URL("../../packages/rig-connect/", import.meta.url)),
        key: "rig-connect",
        manifestPath: "packages/rig-connect/package.json",
        tagPrefix: "rig-connect-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "@slopus/rig-connect", "test"],
        ],
    },
};

export function resolveReleasePackage(value: string | undefined): ReleasePackage {
    const key = value ?? "rig";
    if (
        key !== "rig" &&
        key !== "rig-connect" &&
        key !== "happy-agent-base" &&
        key !== "happy-plugins" &&
        key !== "happy-providers"
    ) {
        throw new Error(
            `Unknown release package ${key}. Expected rig, rig-connect, happy-agent-base, happy-plugins, or happy-providers.`,
        );
    }
    return PACKAGES[key];
}
