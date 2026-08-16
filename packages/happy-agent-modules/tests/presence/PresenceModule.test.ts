import { describe, expect, it, vi } from "vitest";

import { PresenceModule } from "../../sources/presence/PresenceModule.js";
import {
    presenceMigrations,
    PRESENCE_CATALOG_MIGRATION_KEY,
    PRESENCE_MIGRATION_KEY,
    PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
} from "../../sources/presence/PresenceDatabase.js";
import { AWAY_PRESENCE, ONLINE_PRESENCE } from "../../sources/presence/PresenceCatalog.js";
import { presenceUserInputPolicySchema } from "../../sources/presence/PresencePolicy.js";
import { presenceStateSchema } from "../../sources/presence/PresenceState.js";
import { setPresenceTool } from "../../sources/presence/tools/set_presence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { Value } from "@sinclair/typebox/value";

describe("PresenceModule", () => {
    it("owns stable migrations and persists state through Agent Base's database context", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-test");
        await database.ready;
        try {
            expect(presenceMigrations.map(([key]) => key)).toEqual([
                PRESENCE_MIGRATION_KEY,
                PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
                PRESENCE_CATALOG_MIGRATION_KEY,
            ]);

            const module = new PresenceModule({ clock: () => 123 });
            await module.setPresence(database.context, {
                status: "away",
                message: "back soon",
            });

            expect(await module.read(database.context)).toEqual({
                presenceId: "away",
                status: "away",
                title: "Away",
                emoji: "🌙",
                prompt: AWAY_PRESENCE.prompt,
                answerWaitMs: 0,
                message: "back soon",
            });

            const restarted = new PresenceModule({ clock: () => 123 });
            expect(await restarted.read(database.context)).toEqual({
                presenceId: "away",
                status: "away",
                title: "Away",
                emoji: "🌙",
                prompt: AWAY_PRESENCE.prompt,
                answerWaitMs: 0,
                message: "back soon",
            });
        } finally {
            database.close();
        }
    });

    it("uses stdlib afterCommit for committed events and rejects injected stores", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-events-test");
        await database.ready;
        try {
            const events: string[] = [];
            const module = new PresenceModule({
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        events.push(`transactional:${event.type}`);
                    },
                    onEvent: (_ctx, event) => {
                        events.push(`committed:${event.type}`);
                    },
                },
            });

            await module.setPresence(database.context, { status: "online" });
            await module.setPresence(database.context, { status: "online" });
            expect(events).toEqual([
                "transactional:presence_changed",
                "committed:presence_changed",
            ]);

            await module.clear(database.context);
            await module.clear(database.context);
            expect(events).toEqual([
                "transactional:presence_changed",
                "committed:presence_changed",
                "transactional:presence_cleared",
                "committed:presence_cleared",
            ]);

            expect(
                () =>
                    new PresenceModule({
                        store: {},
                    } as never),
            ).toThrow("unknown or invalid keys");
        } finally {
            database.close();
        }
    });

    it("lists custom states, persists definitions, and exposes each wait/display field", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-catalog-test");
        await database.ready;
        try {
            const focus = {
                id: "focus",
                status: "custom" as const,
                title: "Focus time",
                emoji: "🎧",
                prompt: "Continue independently unless an answer is essential.",
                answerWaitMs: 900_000,
            };
            const module = new PresenceModule({
                catalog: [focus],
                clock: () => 10_000,
            });

            expect(await module.listPresences(database.context)).toEqual([
                ...[
                    {
                        ...ONLINE_PRESENCE,
                    },
                    {
                        ...AWAY_PRESENCE,
                    },
                    {
                        id: "offline",
                        status: "offline",
                        title: "Offline",
                        emoji: "⚫",
                        prompt: "The user is offline and cannot be reached. Continue on your own and record anything the user should look at later.",
                        answerWaitMs: 0,
                    },
                    {
                        id: "dnd",
                        status: "dnd",
                        title: "Do not disturb",
                        emoji: "🔕",
                        prompt: "The user has asked not to be disturbed. Continue on your own and record anything the user should look at later.",
                        answerWaitMs: 0,
                    },
                ],
                focus,
            ]);

            await module.setPresence(database.context, { presenceId: "focus" });
            expect(await module.userInputState(database.context)).toEqual({
                answerWaitMs: 900_000,
                title: "Focus time",
                emoji: "🎧",
                prompt: "Continue independently unless an answer is essential.",
            });
            await expect(module.instructions(database.context, {} as never)).resolves.toContain(
                "Continue independently unless an answer is essential.",
            );

            const persisted = {
                id: "meeting",
                status: "custom" as const,
                title: "In a meeting",
                emoji: "📅",
                prompt: "Do not wait for an answer.",
                answerWaitMs: 0,
            };
            await module.setPresenceDefinition(database.context, persisted);
            const restarted = new PresenceModule({ clock: () => 10_000 });
            expect(await restarted.listPresences(database.context)).toContainEqual(persisted);
        } finally {
            database.close();
        }
    });

    it("exposes the TypeBox user-input seam and re-arms subscribers after a change", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-policy-test");
        await database.ready;
        try {
            let now = 1_000;
            const postCommitErrors: unknown[] = [];
            const module = new PresenceModule({
                clock: () => now,
                onPostCommitError: (_ctx, _event, error) => {
                    postCommitErrors.push(error);
                },
            });
            expect(Value.Check(presenceUserInputPolicySchema, module.userInputPolicy)).toBe(true);

            await module.setPresence(database.context, { status: "away" });
            expect(await module.userInputPolicy.state(database.context, "agent-1")).toEqual({
                answerWaitMs: 0,
                title: "Away",
                emoji: "🌙",
                prompt: AWAY_PRESENCE.prompt,
            });

            const changes: unknown[] = [];
            const unsubscribe = await module.userInputPolicy.subscribe(
                database.context,
                "agent-1",
                (_ctx, state) => {
                    changes.push(state);
                },
            );
            now = 2_000;
            await module.setPresence(database.context, { status: "online" });
            await vi.waitFor(() => expect(changes).toHaveLength(2));
            expect(postCommitErrors).toEqual([]);
            expect(changes[1]).toEqual({
                answerWaitMs: null,
                title: "Online",
                emoji: "🟢",
                prompt: ONLINE_PRESENCE.prompt,
            });
            const removed = await unsubscribe?.();
            expect(removed).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("lets the model set an expiry and fallback through the transactional mutation tool", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-tool-commit-test");
        await database.ready;
        try {
            let now = 1_000;
            const module = new PresenceModule({
                allowModelMutation: true,
                clock: () => now,
            });
            const tool = setPresenceTool(module);
            const call = {
                id: "call-presence-1",
                providerCallId: "provider-presence-1",
            } as never;

            const result = await tool.execute(
                database.context,
                {
                    input: {
                        presenceId: "away",
                        until: 2_000,
                        fallbackPresenceId: "online",
                        message: "back soon",
                    },
                },
                call,
            );

            expect(tool.durable).toBe(true);
            expect(tool.transactional).toBe(true);
            expect(result.presence).toMatchObject({
                presenceId: "away",
                status: "away",
                message: "back soon",
                expiresAt: 2_000,
                fallbackPresenceId: "online",
                answerWaitMs: 0,
            });
            expect(Value.Check(presenceStateSchema, result.presence)).toBe(true);

            now = 2_000;
            expect(await module.read(database.context)).toMatchObject({
                presenceId: "online",
                status: "online",
                answerWaitMs: null,
            });
        } finally {
            database.close();
        }
    });
});
