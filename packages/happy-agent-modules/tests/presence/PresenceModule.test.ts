import { describe, expect, it } from "vitest";

import { PresenceModule } from "../../sources/presence/PresenceModule.js";
import {
    presenceMigrations,
    PRESENCE_MIGRATION_KEY,
    PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
} from "../../sources/presence/PresenceDatabase.js";
import { setPresenceTool } from "../../sources/presence/tools/set_presence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("PresenceModule", () => {
    it("owns a stable migration and persists state through Agent Base's database context", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-test");
        await database.ready;
        try {
            expect(presenceMigrations.map(([key]) => key)).toEqual([
                PRESENCE_MIGRATION_KEY,
                PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
            ]);

            const module = new PresenceModule({ clock: () => 123 });
            await module.setPresence(database.context, {
                status: "away",
                message: "back soon",
            });

            expect(await module.read(database.context)).toEqual({
                status: "away",
                message: "back soon",
            });

            const restarted = new PresenceModule({ clock: () => 123 });
            expect(await restarted.read(database.context)).toEqual({
                status: "away",
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

    it("marks the durable set tool transactional", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-tool-commit-test");
        await database.ready;
        try {
            const module = new PresenceModule();
            const tool = setPresenceTool(module);
            const call = {
                id: "call-presence-1",
                providerCallId: "provider-presence-1",
            } as never;

            const result = await tool.execute(
                database.context,
                { status: "away", message: "back soon" },
                call,
            );

            expect(tool.durable).toBe(true);
            expect(tool.transactional).toBe(true);
            expect(result).toEqual({
                presence: { status: "away", message: "back soon" },
            });
            expect(await module.read(database.context)).toEqual(result.presence);
        } finally {
            database.close();
        }
    });
});
