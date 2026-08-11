import { describe, expect, it } from "vitest";

import { daemonIdentitiesMatch } from "./daemonIdentitiesMatch.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";

describe("daemonIdentitiesMatch", () => {
    it("uses the package version for production daemons", () => {
        expect(daemonIdentitiesMatch({ version: "1.2.3" }, { version: "1.2.3" })).toBe(true);
        expect(daemonIdentitiesMatch({ version: "1.2.3" }, { version: "1.2.2" })).toBe(false);
    });

    it("also requires the current source build in development", () => {
        expect(
            daemonIdentitiesMatch(
                { developmentBuildId: "current", version: "1.2.3" },
                { developmentBuildId: "current", version: "1.2.3" },
            ),
        ).toBe(true);
        expect(
            daemonIdentitiesMatch(
                { developmentBuildId: "current", version: "1.2.3" },
                { developmentBuildId: "older", version: "1.2.3" },
            ),
        ).toBe(false);
    });

    it("lets global development execute current source under the installed release identity", () => {
        const identity = getDaemonIdentity(
            {
                RIG_DAEMON_IDENTITY_VERSION: "0.2.3",
                RIG_RUNTIME_MODE: "global-development",
            },
            "0.2.7",
        );

        expect(identity).toEqual({ version: "0.2.3" });
        expect(daemonIdentitiesMatch({ version: "0.2.3" }, identity)).toBe(true);
    });
});
