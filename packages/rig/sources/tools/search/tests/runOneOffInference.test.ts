import { describe, expect, it, vi } from "vitest";
import type {
    BaseProvider,
    BaseSession,
    SessionEvent,
    SessionOptions,
    SessionRunRequest,
} from "@slopus/rig-providers";
import { builtinModelProfiles } from "@slopus/rig-execution";

import { runOneOffInference } from "../runOneOffInference.js";

describe("runOneOffInference", () => {
    it("opens one direct provider session, consumes it, and destroys it", async () => {
        const events: SessionEvent[] = [
            { type: "text_delta", delta: "Direct " },
            { type: "text_delta", delta: "answer" },
            { type: "done", state: "normal" },
        ];
        const session = fakeSession(events);
        const native = fakeProvider(session);
        const profile = builtinModelProfiles("codex", "codex")[0]!;

        const result = await runOneOffInference({
            instructions: "Answer one bounded question.",
            prompt: "Summarize this.",
            route: {
                profile,
                provider: {
                    id: "codex",
                    native,
                    profiles: [profile],
                },
            },
            tools: [{ name: "web_search", server: { type: "web_search" } }],
        });

        expect(result.text).toBe("Direct answer");
        const sessionId = native.session.mock.calls[0]?.[0];
        expect(sessionId).toMatch(/^one-off:[0-9a-f]{16}:[a-z0-9]{24}$/u);
        expect(sessionId).toHaveLength(49);
        expect(native.session).toHaveBeenCalledWith(sessionId, {
            inferenceMaxRetries: 0,
            instructions: "Answer one bounded question.",
            tools: [{ name: "web_search", server: { type: "web_search" } }],
        });
        expect(session.run).toHaveBeenCalledWith(
            expect.objectContaining({
                context: { messages: [{ role: "user", content: "Summarize this." }] },
                model: profile.id,
            }),
        );
        expect(session.destroy).toHaveBeenCalledOnce();
    });

    it("returns as soon as the provider emits done even if its stream never closes", async () => {
        const session = sessionThatHangsAfter([
            { type: "text_delta", delta: "Finished" },
            { type: "done", state: "normal" },
        ]);
        const native = fakeProvider(session);
        const profile = builtinModelProfiles("codex", "codex")[0]!;

        await expect(
            runOneOffInference({
                instructions: "Search once.",
                prompt: "Find Rig.",
                route: {
                    profile,
                    provider: {
                        id: "codex",
                        native,
                        profiles: [profile],
                    },
                },
                timeoutMs: 20,
            }),
        ).resolves.toMatchObject({ text: "Finished" });
        expect(session.destroy).toHaveBeenCalledOnce();
    });

    it("times out and destroys a provider session that never emits done", async () => {
        const session = sessionThatHangsAfter([]);
        const native = fakeProvider(session);
        const profile = builtinModelProfiles("codex", "codex")[0]!;

        await expect(
            runOneOffInference({
                instructions: "Search once.",
                prompt: "Find Rig.",
                route: {
                    profile,
                    provider: {
                        id: "codex",
                        native,
                        profiles: [profile],
                    },
                },
                timeoutMs: 20,
            }),
        ).rejects.toThrow("timed out after 20 ms");
        expect(session.destroy).toHaveBeenCalledOnce();
    });

    it("keeps the native session id bounded even when the configured provider id is long", async () => {
        const session = fakeSession([{ type: "done", state: "normal" }]);
        const native = fakeProvider(session);
        const profile = builtinModelProfiles("codex", "codex")[0]!;

        await runOneOffInference({
            instructions: "Search once.",
            prompt: "Find Rig.",
            route: {
                profile,
                provider: {
                    id: "codex-provider-with-a-very-long-identifier-that-must-not-leak-into-the-native-session-id",
                    native,
                    profiles: [profile],
                    sessionId:
                        "configured-session-with-a-very-long-identifier-that-exceeds-provider-cache-key-limits",
                },
            },
        });

        const sessionId = native.session.mock.calls[0]?.[0];
        expect(sessionId).toMatch(/^one-off:[0-9a-f]{16}:[a-z0-9]{24}$/u);
        expect(sessionId.length).toBeLessThanOrEqual(64);
    });
});

function fakeProvider(session: BaseSession) {
    return {
        session: vi.fn(async (_id: string, _options: SessionOptions) => session),
    } as unknown as BaseProvider & { session: ReturnType<typeof vi.fn> };
}

function fakeSession(events: readonly SessionEvent[]) {
    return {
        compact: vi.fn(),
        destroy: vi.fn(),
        run: vi.fn((_request: SessionRunRequest) => ({
            async *[Symbol.asyncIterator]() {
                for (const event of events) yield event;
            },
        })),
    } as unknown as BaseSession & {
        destroy: ReturnType<typeof vi.fn>;
        run: ReturnType<typeof vi.fn>;
    };
}

function sessionThatHangsAfter(events: readonly SessionEvent[]) {
    return {
        compact: vi.fn(),
        destroy: vi.fn(),
        run: vi.fn((_request: SessionRunRequest) => ({
            async *[Symbol.asyncIterator]() {
                for (const event of events) yield event;
                await new Promise<never>(() => {});
            },
        })),
    } as unknown as BaseSession & {
        destroy: ReturnType<typeof vi.fn>;
        run: ReturnType<typeof vi.fn>;
    };
}
