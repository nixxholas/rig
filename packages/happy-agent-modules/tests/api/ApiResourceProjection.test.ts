import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { eventIdSchema } from "../../sources/events/index.js";
import { apiResourceVersion } from "../../sources/api/ApiResourceProjection.js";

describe("apiResourceVersion", () => {
    it("projects a numeric module version into a deterministic ordered UUIDv7", () => {
        const first = apiResourceVersion(1_755_400_000_000, 7, "project-a");
        const repeated = apiResourceVersion(1_755_400_000_000, 7, "project-a");
        const next = apiResourceVersion(1_755_400_000_000, 8, "project-a");

        expect(Value.Check(eventIdSchema, first)).toBe(true);
        expect(repeated).toBe(first);
        expect(next > first).toBe(true);
    });

    it("keeps resource identities distinct at the same timestamp and counter", () => {
        expect(apiResourceVersion(1, 1, "a")).not.toBe(apiResourceVersion(1, 1, "b"));
    });
});
