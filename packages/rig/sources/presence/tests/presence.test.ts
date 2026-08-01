import { describe, expect, it, vi } from "vitest";

import { createConfiguredPresenceStore } from "../createConfiguredPresenceStore.js";
import { describeUnansweredQuestion } from "../describeUnansweredQuestion.js";
import { PresenceStore } from "../PresenceStore.js";
import { resolvePresences } from "../resolvePresences.js";

describe("presence", () => {
    it("always offers Online and Away, and Online never stops waiting", () => {
        const presences = resolvePresences();

        expect(presences.map((presence) => presence.id)).toEqual(["online", "away"]);
        expect(presences[0]?.answerWaitMs).toBeNull();
        expect(presences[1]?.answerWaitMs).toBe(0);
    });

    it("lets configuration change a built-in state and add its own", () => {
        const presences = resolvePresences({
            away: { emoji: "🚶", title: "Stepped out" },
            meeting: {
                answerWaitMs: 900_000,
                emoji: "📅",
                prompt: "In a meeting.",
                title: "In a meeting",
            },
        });

        expect(presences.map((presence) => presence.title)).toEqual([
            "Online",
            "Stepped out",
            "In a meeting",
        ]);
        expect(presences[1]?.prompt).toContain("cannot be reached");
        expect(presences[2]?.answerWaitMs).toBe(900_000);
    });

    it("remembers the chosen state and falls back when it expires", async () => {
        let now = 1_000;
        const written: string[] = [];
        const store = new PresenceStore({
            now: () => now,
            persist: async (selection) => {
                written.push(selection.presenceId);
            },
            presences: resolvePresences(),
        });

        expect(store.state().presence.id).toBe("online");

        const away = await store.setPresence({ presenceId: "away", until: 5_000 });

        expect(away.presence.id).toBe("away");
        expect(away.changesAt).toBe(5_000);
        expect(written).toEqual(["away"]);

        now = 5_001;

        expect(store.state().presence.id).toBe("online");
        store.close();
    });

    it("serializes an expiry write ahead of a newer manual selection", async () => {
        let releaseExpiry!: () => void;
        const expiryCanFinish = new Promise<void>((resolve) => {
            releaseExpiry = resolve;
        });
        const writes: string[] = [];
        let persisted = "away";
        const store = new PresenceStore({
            now: () => 5_001,
            persist: async (selection) => {
                writes.push(selection.presenceId);
                if (writes.length === 1) await expiryCanFinish;
                persisted = selection.presenceId;
            },
            presences: resolvePresences(),
            selection: { presenceId: "away", since: 1_000, until: 5_000 },
        });

        expect(store.state().presence.id).toBe("online");
        const setting = store.setPresence({ presenceId: "away" });
        await Promise.resolve();

        expect(writes).toEqual(["online"]);
        releaseExpiry();
        await setting;

        expect(writes).toEqual(["online", "away"]);
        expect(persisted).toBe("away");
        expect(store.state().presence.id).toBe("away");
        store.close();
    });

    it("publishes an automatic expiry exactly once", async () => {
        vi.useFakeTimers();
        let now = 1_000;
        const store = new PresenceStore({
            now: () => now,
            persist: async () => undefined,
            presences: resolvePresences(),
        });
        try {
            await store.setPresence({ presenceId: "away", until: 2_000 });
            const changed = vi.fn();
            store.onChange(changed);

            now = 2_001;
            await vi.advanceTimersByTimeAsync(1_000);

            expect(changed).toHaveBeenCalledOnce();
            expect(changed.mock.calls[0]?.[0].presence.id).toBe("online");
        } finally {
            store.close();
            vi.useRealTimers();
        }
    });

    it("publishes an observed expiry even when persistence fails", async () => {
        const store = new PresenceStore({
            now: () => 2_001,
            persist: () => Promise.reject(new Error("disk unavailable")),
            presences: resolvePresences(),
            selection: { presenceId: "away", since: 1_000, until: 2_000 },
        });
        const changed = vi.fn();
        store.onChange(changed);

        expect(store.state().presence.id).toBe("online");
        await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());

        expect(changed.mock.calls[0]?.[0].presence.id).toBe("online");
        store.close();
    });

    it("refuses a state nobody configured", async () => {
        const store = new PresenceStore({ presences: resolvePresences() });

        await expect(store.setPresence({ presenceId: "sleeping" })).rejects.toThrow(
            'There is no presence called "sleeping".',
        );
        store.close();
    });

    it("starts in the state the configuration last recorded", () => {
        const store = createConfiguredPresenceStore(
            { current: "away", states: {} },
            { now: () => 10, persist: async () => undefined },
        );

        expect(store.state().presence.id).toBe("away");
        store.close();
    });

    it("starts in the fallback when a temporary configured state expired offline", () => {
        const store = createConfiguredPresenceStore(
            { current: "away", fallback: "online", states: {}, until: 5_000 },
            { now: () => 6_000, persist: async () => undefined },
        );

        expect(store.state()).toMatchObject({
            presence: { id: "online" },
            since: 5_000,
        });
        expect(store.state().changesAt).toBeUndefined();
        store.close();
    });

    it("tells the model why nobody answered and how to withdraw the question", () => {
        const [online, away] = resolvePresences();

        expect(
            describeUnansweredQuestion({
                askId: "ask-7",
                changesAt: 3_600_000,
                now: 0,
                presence: away!,
                reason: "away",
                waitedMs: 0,
            }),
        ).toBe(
            "The question was not asked interactively because the user is Away 🌙. " +
                `${away!.prompt} ` +
                "The user expects to change this state in about 1 hour. " +
                "The question is waiting in the user's inbox as ask ask-7; call cancel_ask with that id if you no longer need an answer. " +
                "Continue on your own with your best judgement.",
        );
        expect(
            describeUnansweredQuestion({
                askId: "ask-8",
                now: 0,
                presence: { ...online!, answerWaitMs: 900_000, title: "In a meeting", emoji: "📅" },
                reason: "timeout",
                waitedMs: 900_000,
            }),
        ).toContain("Nobody answered within 15 minutes");
    });
});
