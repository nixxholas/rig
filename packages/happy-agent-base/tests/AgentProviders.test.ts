import type { BaseProvider } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import { AgentProviders } from "../sources/index.js";

function provider(): BaseProvider {
    return {
        session: () => Promise.reject(new Error("Not implemented.")),
    } as unknown as BaseProvider;
}

describe("AgentProviders", () => {
    it("reads registered providers by ID", () => {
        const codex = provider();
        const claude = provider();
        const providers = new AgentProviders();
        providers.add("codex", codex, "codex");
        providers.add("claude", claude, "claude");

        expect(providers.get("codex")).toBe(codex);
        expect(providers.get("claude")).toBe(claude);
        expect(providers.typeOf("codex")).toBe("codex");
        expect(providers.typeOf("claude")).toBe("claude");
        expect(providers.ids).toEqual(["codex", "claude"]);
    });

    it("returns null for an unknown provider", () => {
        const providers = new AgentProviders();

        expect(providers.get("missing")).toBeNull();
        expect(providers.typeOf("missing")).toBeNull();
    });

    it("adds and removes providers on the fly", () => {
        const providers = new AgentProviders();
        const grok = provider();

        providers.add("grok", grok, "grok");
        expect(providers.get("grok")).toBe(grok);

        expect(providers.remove("grok")).toBe(true);
        expect(providers.get("grok")).toBeNull();
        expect(providers.remove("grok")).toBe(false);
    });

    it("allows one provider instance under several IDs but rejects duplicate IDs", () => {
        const shared = provider();
        const providers = new AgentProviders();
        providers.add("codex", shared, "codex");
        providers.add("bulka_codex", shared, "codex");

        expect(providers.get("codex")).toBe(shared);
        expect(providers.get("bulka_codex")).toBe(shared);
        expect(() => {
            providers.add("codex", provider(), "codex");
        }).toThrowError('Provider "codex" is already registered.');
    });
});
