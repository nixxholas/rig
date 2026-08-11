import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import type { GrokCredential } from "@/vendors/VendorCredential.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { grok_server_tools } from "@/vendors/grok/tools/index.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;

async function resolveGrokCredential(): Promise<GrokCredential | null> {
    return (await GrokSessionCredential.tryLoad()) ?? (await GrokApiKeyCredential.tryLoad());
}

function serverStarts(events: readonly SessionEvent[]) {
    return events.filter(
        (event): event is Extract<SessionEvent, { type: "toolcall_start" }> & { server: true } =>
            event.type === "toolcall_start" && event.server === true,
    );
}

/**
 * Native Grok server search on the main request: declare grok_server_tools, get server:true
 * starts, and never leave client tool work open.
 */
describeLive("Grok native server search live", () => {
    it("runs web_search on the main response with server:true", { timeout: 180_000 }, async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no Grok credentials were found");
        }

        const provider = new GrokProvider({ credential });
        const session = await provider.session(`grok-native-web-${Date.now()}`, {
            instructions: "You are a concise assistant. Always use web_search for current facts.",
            tools: grok_server_tools.filter((tool) => tool.name === "web_search"),
        });
        const events = await collectSessionEvents(
            session.run({
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "<user_query>Search the web for the current Node.js LTS version and cite one official URL.</user_query>",
                                },
                            ],
                        },
                    ],
                },
                model: "grok-4.5",
                effort: "low",
            }),
        );

        const searches = serverStarts(events);
        expect(searches.length).toBeGreaterThan(0);
        expect(searches.every((event) => event.name === "web_search")).toBe(true);
        expect(
            events.filter((event) => event.type === "toolcall_start" && event.server !== true),
        ).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events).length).toBeGreaterThan(0);
    });

    it("runs x_search on the main response with server:true", { timeout: 180_000 }, async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no Grok credentials were found");
        }

        const provider = new GrokProvider({ credential });
        const session = await provider.session(`grok-native-x-${Date.now()}`, {
            instructions: "You are a concise assistant. Always use x_search for X posts.",
            tools: grok_server_tools.filter((tool) => tool.name === "x_search"),
        });
        const events = await collectSessionEvents(
            session.run({
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "<user_query>Search X for recent posts about Claude Code and reply with one post URL.</user_query>",
                                },
                            ],
                        },
                    ],
                },
                model: "grok-4.5",
                effort: "low",
            }),
        );

        const searches = serverStarts(events);
        expect(searches.length).toBeGreaterThan(0);
        expect(searches.every((event) => event.name.startsWith("x_"))).toBe(true);
        expect(
            events.filter((event) => event.type === "toolcall_start" && event.server !== true),
        ).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events).toLowerCase()).toMatch(/x\.com\//);
    });
});
