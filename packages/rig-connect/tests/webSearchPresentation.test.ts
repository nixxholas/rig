import { describe, expect, it } from "vitest";

import { projectToolPresentation } from "@/ToolPresentation.js";

/**
 * Rig runs some searches itself and the provider runs others on its own backend, but a search
 * that the provider ran arrives as an ordinary tool call like any other. These pin the shared
 * presentation, so a search cannot start reading differently depending on who ran it.
 */
describe("a search, whoever ran it", () => {
    it("reaches the interface as one value from a call and its result", () => {
        expect(
            projectToolPresentation(undefined, {
                query: "Node.js current stable version",
                sources: [
                    { url: "https://nodejs.org/en/about/previous-releases" },
                    { url: "https://nodejs.org/en" },
                ],
                target: "web",
                type: "search",
            }),
        ).toEqual({
            kind: "search",
            query: "Node.js current stable version",
            sources: [
                { url: "https://nodejs.org/en/about/previous-releases" },
                { url: "https://nodejs.org/en" },
            ],
            target: "web",
        });
    });

    // The row a reader is watching must not change kind when the search finishes, so the call
    // half already says it is a search and simply has nothing to cite yet.
    it("is a search from the moment it starts, before it has consulted anything", () => {
        expect(
            projectToolPresentation(
                { query: "rust async traits", target: "web", type: "search" },
                undefined,
            ),
        ).toEqual({ kind: "search", query: "rust async traits", sources: [], target: "web" });
    });

    // The result is the later and more complete account of the same act.
    it("takes the finished search over the one that was announced", () => {
        expect(
            projectToolPresentation(
                { query: "announced", target: "web", type: "search" },
                {
                    query: "what actually ran",
                    sources: [{ title: "Node", url: "https://nodejs.org/en" }],
                    target: "web",
                    type: "search",
                },
            ),
        ).toEqual({
            kind: "search",
            query: "what actually ran",
            sources: [{ title: "Node", url: "https://nodejs.org/en" }],
            target: "web",
        });
    });
});
