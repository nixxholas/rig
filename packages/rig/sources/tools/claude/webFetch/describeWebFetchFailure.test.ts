import { describe, expect, it } from "vitest";

import { describeWebFetchFailure } from "./describeWebFetchFailure.js";

/** How Node reports a network failure: an opaque wrapper with the real reason as its cause. */
function fetchFailure(code: string, message: string): Error {
    const cause = new Error(message);
    (cause as { code?: string }).code = code;
    return new Error("fetch failed", { cause });
}

describe("describing a page that could not be fetched", () => {
    it("says a site could not be found rather than that a fetch failed", () => {
        expect(
            describeWebFetchFailure(
                "https://scottwiener.wtf",
                fetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND scottwiener.wtf"),
            ),
        ).toBe("scottwiener.wtf could not be found. Check the address, or the site may not exist.");
    });

    it("separates a refused connection from a missing site", () => {
        expect(
            describeWebFetchFailure(
                "https://localhost:9/x",
                fetchFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9"),
            ),
        ).toBe("localhost refused the connection.");
    });

    it("names a timeout as a timeout", () => {
        expect(
            describeWebFetchFailure(
                "https://slow.example",
                fetchFailure("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"),
            ),
        ).toBe("slow.example did not answer in time.");
    });

    it("names a certificate problem", () => {
        expect(
            describeWebFetchFailure(
                "https://expired.example",
                fetchFailure("CERT_HAS_EXPIRED", "certificate has expired"),
            ),
        ).toBe("expired.example presented a certificate that is not valid.");
    });

    /**
     * The reason this exists: repeating Node's own wording would leave the reader exactly where
     * they started, so an unrecognised failure still has to say which host and what happened.
     */
    it("never answers with the opaque wording it replaces", () => {
        const described = describeWebFetchFailure(
            "https://odd.example/page",
            new Error("fetch failed"),
        );
        expect(described).toBe("odd.example could not be reached.");
        expect(described).not.toContain("fetch failed");
    });

    it("keeps a specific cause when there is no code to recognise", () => {
        expect(
            describeWebFetchFailure(
                "https://odd.example",
                new Error("fetch failed", { cause: new Error("unsupported protocol") }),
            ),
        ).toBe("odd.example could not be reached: unsupported protocol");
    });
});
