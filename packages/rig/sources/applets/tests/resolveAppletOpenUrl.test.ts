import { describe, expect, it } from "vitest";

import { AppletContextTokenStore } from "../AppletContextTokenStore.js";
import { resolveAppletOpenUrl } from "../resolveAppletOpenUrl.js";

describe("resolveAppletOpenUrl", () => {
    it("drops empty and dot path segments before building the served applet URL", () => {
        const tokens = new AppletContextTokenStore({
            randomToken: () => "opaque-token",
        });

        expect(
            resolveAppletOpenUrl(
                "dashboard",
                { path: "../reports/./daily.html" },
                { version: 1, applet: "dashboard" },
                tokens,
            ),
        ).toBe("/applets/dashboard/files/reports/daily.html?rigContext=opaque-token");
    });
});
