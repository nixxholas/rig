import { describe, expect, it } from "vitest";

import { endpointUrl } from "@/endpointUrl.js";

describe("endpointUrl", () => {
    it("keeps endpoint and request query parameters without rewriting them", () => {
        expect(
            endpointUrl(
                "https://connector.test/capability/rig?tenant=acme&signature=one%20two",
                "events/live?after=cursor%2Fone",
            ),
        ).toBe(
            "https://connector.test/capability/rig/events/live?after=cursor%2Fone&tenant=acme&signature=one%20two",
        );
    });
});
