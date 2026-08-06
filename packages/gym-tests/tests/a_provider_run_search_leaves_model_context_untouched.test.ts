import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** Role and block kinds only: the shape a cached prefix is matched on, without the prose. */
function contextShape(
    messages: readonly { role: string; content?: readonly { type: string }[] }[],
): { blocks: string[]; role: string }[] {
    return messages.map((message) => ({
        blocks: (message.content ?? []).map((block) => block.type),
        role: message.role,
    }));
}

/**
 * What the model context holds on the turn after the provider ran a search of its own.
 *
 * A hosted search is answered inside the provider's response, so Rig only ever learns it happened.
 * It is transcript content, and transcript content is not model context: a search that reached the
 * message list would change the prefix every following turn is matched against, and a changed
 * prefix is a cold cache on every one of them.
 *
 * This measures the message list and nothing else. A provider's own response items are the other
 * half of what it is sent, and the gym's provider does not produce them, so this cannot speak for
 * them; `codexResponseItems` covers that half against the captured Codex shape. Read the two
 * together before concluding anything about what a follow-up request costs.
 *
 * Anything that moves a provider-run search closer to the message it accompanied has to leave this
 * exactly as it is, and this fails if it does not.
 */
describe("the turn after the provider ran its own search", () => {
    it("sends the model the same context it would have sent with no search at all", async () => {
        const withSearch = await createGym({
            cols: 96,
            inference: [
                {
                    content: [{ text: "People are praising it.", type: "text" }],
                    serverToolCalls: [
                        {
                            arguments: '{"query":"Claude Code","limit":"5","mode":"Latest"}',
                            callId: "x-keyword-1",
                            name: "x_keyword_search",
                        },
                        {
                            arguments: '{"query":"Claude Code reviews"}',
                            callId: "ws-1",
                            name: "web_search",
                        },
                    ],
                },
                { content: [{ text: "That is everything I found.", type: "text" }] },
            ],
            rows: 32,
        });
        running.add(withSearch);

        withSearch.terminal.type("What is X saying about Claude Code?");
        withSearch.terminal.press("enter");
        await withSearch.terminal.waitForText("People are praising it.", 30_000);
        withSearch.terminal.type("Anything else?");
        withSearch.terminal.press("enter");
        await withSearch.terminal.waitForText("That is everything I found.", 30_000);

        const searched = withSearch.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(searched).toHaveLength(2);

        // The same conversation, with the provider running no search at all. Its follow-up request
        // is the baseline: the searching one has to match it message for message.
        const withoutSearch = await createGym({
            cols: 96,
            inference: [
                { content: [{ text: "People are praising it.", type: "text" }] },
                { content: [{ text: "That is everything I found.", type: "text" }] },
            ],
            rows: 32,
        });
        running.add(withoutSearch);

        withoutSearch.terminal.type("What is X saying about Claude Code?");
        withoutSearch.terminal.press("enter");
        await withoutSearch.terminal.waitForText("People are praising it.", 30_000);
        withoutSearch.terminal.type("Anything else?");
        withoutSearch.terminal.press("enter");
        await withoutSearch.terminal.waitForText("That is everything I found.", 30_000);

        const plain = withoutSearch.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(plain).toHaveLength(2);

        const searchedShape = contextShape(searched[1]?.context.messages ?? []);
        expect(searchedShape).toEqual(contextShape(plain[1]?.context.messages ?? []));

        // And the text itself, so a search cannot arrive as prose inside a block that already fits
        // the shape above.
        const text = (messages: readonly { content?: readonly unknown[] }[]) =>
            JSON.stringify(messages.map((message) => message.content ?? []));
        expect(text(searched[1]?.context.messages ?? [])).toBe(
            text(plain[1]?.context.messages ?? []),
        );

        // The prefix a cache is keyed on is the whole conversation before the new question, so the
        // assistant turn carrying the searches must hold nothing but the answer it spoke.
        const assistant = (searched[1]?.context.messages ?? []).filter(
            (message) => message.role === "assistant",
        );
        expect(assistant).toHaveLength(1);
        expect(assistant[0]?.content).toEqual([
            { text: "People are praising it.", type: "text" },
        ]);
    }, 180_000);
});
