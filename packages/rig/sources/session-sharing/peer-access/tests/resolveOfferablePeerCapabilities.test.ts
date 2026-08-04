import { describe, expect, it } from "vitest";

import type { DockerExecutionConfig } from "../../../execution/index.js";
import { resolveOfferablePeerCapabilities } from "../resolveOfferablePeerCapabilities.js";

describe("resolveOfferablePeerCapabilities", () => {
    it("carries the grant-time irreversibility warning on every entry, offerable or not", () => {
        const [hostEntry] = resolveOfferablePeerCapabilities(undefined);
        const [containerEntry] = resolveOfferablePeerCapabilities({} as DockerExecutionConfig);

        for (const entry of [hostEntry, containerEntry]) {
            expect(entry?.grantWarning).toMatch(/cannot recall/i);
            expect(entry?.grantWarning.toLowerCase()).toContain("rotate");
        }
        expect(hostEntry?.offerable).toBe(false);
        expect(containerEntry?.offerable).toBe(true);
    });
});
