import { describe, expect, it } from "vitest";

import { getDefaultGlobalConfigPath } from "./getDefaultGlobalConfigPath.js";
import { getGlobalAgentsMdPath } from "./getGlobalAgentsMdPath.js";
import { getHappyConfigDirectory } from "./getHappyConfigDirectory.js";

describe("getHappyConfigDirectory", () => {
    it("uses title case on macOS and lowercase on Linux", () => {
        expect(getHappyConfigDirectory({}, "/Users/tester", "darwin")).toBe(
            "/Users/tester/Happy/Config",
        );
        expect(getHappyConfigDirectory({}, "/home/tester", "linux")).toBe(
            "/home/tester/happy/config",
        );
    });

    it("honors an absolute RIG_CONFIGURATION_DIRECTORY", () => {
        expect(
            getHappyConfigDirectory(
                { RIG_CONFIGURATION_DIRECTORY: "/srv/happy-config" },
                "/home/tester",
                "linux",
            ),
        ).toBe("/srv/happy-config");
    });

    it("rejects a relative RIG_CONFIGURATION_DIRECTORY", () => {
        expect(() =>
            getHappyConfigDirectory(
                { RIG_CONFIGURATION_DIRECTORY: "relative/config" },
                "/home/tester",
                "linux",
            ),
        ).toThrow("RIG_CONFIGURATION_DIRECTORY must be an absolute path.");
    });

    it("keeps happy.toml and AGENTS.md together in the configuration directory", () => {
        const environment = {
            RIG_CONFIGURATION_DIRECTORY: "/srv/happy-config",
        };

        expect(getDefaultGlobalConfigPath(environment, "/home/tester")).toBe(
            "/srv/happy-config/happy.toml",
        );
        expect(getGlobalAgentsMdPath(environment, "/home/tester")).toBe(
            "/srv/happy-config/AGENTS.md",
        );
    });
});
