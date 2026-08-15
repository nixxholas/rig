import { describe, expect, it } from "vitest";

import { resolveWorkletPermissions } from "../resolveWorkletPermissions.js";
import { WorkletInvalidError } from "../WorkletInvalidError.js";

const environment = { HAPPY_WORKLETS_DIRECTORY: "/worklets" };
const home = "/home/steve";

describe("resolveWorkletPermissions", () => {
    it("grants nothing beyond the data folder for a worklet that asked for nothing", () => {
        const resolved = resolveWorkletPermissions(
            { disk: "none", network: "none" },
            { environment, homeDirectory: home },
        );

        expect(resolved).toEqual({
            fullDiskAccess: false,
            fullNetworkAccess: false,
            writablePaths: [],
        });
        expect(resolved.networkPolicy).toBeUndefined();
    });

    it("turns declared hosts into an allow list, assuming HTTPS when no port is given", () => {
        const resolved = resolveWorkletPermissions(
            {
                disk: "none",
                network: { hosts: ["api.github.com", "*.example.com", "localhost:8080"] },
            },
            { environment, homeDirectory: home },
        );

        expect(resolved.networkPolicy).toEqual({
            allowedDomains: [
                { domain: "api.github.com", ports: [443] },
                { domain: "*.example.com", ports: [443] },
                { domain: "localhost", ports: [8080] },
            ],
        });
    });

    it("refuses a host that is a URL, a path, or an impossible port", () => {
        for (const host of ["https://api.github.com", "api.github.com/repos", "example.com:0"]) {
            expect(() =>
                resolveWorkletPermissions(
                    { disk: "none", network: { hosts: [host] } },
                    { environment, homeDirectory: home },
                ),
            ).toThrow(WorkletInvalidError);
        }
    });
});
