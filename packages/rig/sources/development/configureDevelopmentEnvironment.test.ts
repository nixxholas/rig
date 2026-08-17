import { describe, expect, it } from "vitest";

import { getHappyDaemonPaths } from "../daemon/getHappyDaemonPaths.js";
import { configureDevelopmentEnvironment } from "./configureDevelopmentEnvironment.js";

describe("configureDevelopmentEnvironment", () => {
    it("places the daemon in the development checkout", async () => {
        const environment = { RIG_DEVELOPMENT_BUILD_ID: "existing-build" };

        await configureDevelopmentEnvironment({
            environment,
            repositoryRoot: "/workspace/rig",
        });

        expect(environment).toEqual({
            HAPPY_HOME_DIR: "/workspace/rig/.rig-dev/.happy",
            RIG_DEVELOPMENT_BUILD_ID: "existing-build",
        });
    });

    it("replaces an inherited global Happy home with checkout-local development state", async () => {
        const environment = {
            HAPPY_HOME_DIR: "/home/user/.happy",
            RIG_DEVELOPMENT_BUILD_ID: "existing-build",
        };

        await configureDevelopmentEnvironment({
            environment,
            repositoryRoot: "/workspace/rig",
        });

        expect(environment.HAPPY_HOME_DIR).toBe("/workspace/rig/.rig-dev/.happy");
        expect(getHappyDaemonPaths(environment, "/home/user")).toEqual({
            directory: "/workspace/rig/.rig-dev/.happy/agent",
            happyHome: "/workspace/rig/.rig-dev/.happy",
            logPath: "/workspace/rig/.rig-dev/.happy/agent/daemon.log",
            socketPath: "/workspace/rig/.rig-dev/.happy/agent/server.sock",
            tokenPath: "/workspace/rig/.rig-dev/.happy/agent/token",
        });
    });
});
