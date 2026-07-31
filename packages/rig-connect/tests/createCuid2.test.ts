import { describe, expect, it } from "vitest";

import { createCuid2 } from "@/createCuid2.js";

describe("createCuid2", () => {
    it("produces identities a daemon accepts as cuid2", () => {
        const nextId = createCuid2();
        const ids = Array.from({ length: 1_000 }, () => nextId());

        for (const id of ids) expect(id).toMatch(/^[a-z][0-9a-z]{23}$/u);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("still separates identities when the clock and the random source repeat", () => {
        // A client names entities in bursts, and a stubbed or weak random source
        // must not be the only thing keeping two of them apart.
        const nextId = createCuid2(
            () => 1_700_000_000_000,
            (bytes) => bytes.fill(7),
        );
        const ids = Array.from({ length: 500 }, () => nextId());

        expect(new Set(ids).size).toBe(ids.length);
    });
});
