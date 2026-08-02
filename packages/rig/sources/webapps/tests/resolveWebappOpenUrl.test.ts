import { describe, expect, it } from "vitest";

import { WebappContextTokenStore } from "../WebappContextTokenStore.js";
import { resolveWebappOpenUrl } from "../resolveWebappOpenUrl.js";

describe("resolveWebappOpenUrl", () => {
    it("drops empty and dot path segments before building the served webapp URL", () => {
        const tokens = new WebappContextTokenStore({
            randomToken: () => "opaque-token",
        });

        expect(
            resolveWebappOpenUrl(
                "dashboard",
                { path: "../reports/./daily.html" },
                { version: 1, webapp: "dashboard" },
                tokens,
            ),
        ).toBe("/webapps/dashboard/files/reports/daily.html?rigContext=opaque-token");
    });
});
