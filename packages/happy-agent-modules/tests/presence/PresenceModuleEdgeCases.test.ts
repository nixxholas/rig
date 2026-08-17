import { sql } from "drizzle-orm";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { AWAY_PRESENCE } from "../../sources/presence/PresenceCatalog.js";
import {
    PresenceModule,
    presenceModuleOptionsSchema,
} from "../../sources/presence/PresenceModule.js";
import { presenceUserInputPolicySchema } from "../../sources/presence/PresencePolicy.js";
import { presenceStateSchema } from "../../sources/presence/PresenceState.js";
import { presenceEventSchema } from "../../sources/presence/PresenceEvent.js";
import { getPresenceTool } from "../../sources/presence/tools/get_presence.js";
import { listPresenceTool } from "../../sources/presence/tools/list_presence.js";
import { setPresenceTool } from "../../sources/presence/tools/set_presence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const focus = {
    id: "focus",
    status: "custom" as const,
    title: "Focus",
    emoji: "🎧",
    prompt: "Continue independently unless an answer is essential.",
    answerWaitMs: 15 * 60 * 1000,
};

function schedule(overrides: Record<string, unknown> = {}) {
    return {
        days: [1],
        startTime: "09:00",
        endTime: "17:00",
        timeZone: "UTC",
        presence: { status: "away" as const },
        ...overrides,
    };
}

function llmText(blocks: readonly { readonly type: string }[]): string {
    const block = blocks[0];
    return block !== undefined && "text" in block && typeof block.text === "string"
        ? block.text
        : "";
}

describe("PresenceModule edge cases", () => {
    it("validates constructor options, keeps built-in tools read-only by default, and exposes model mutation only when enabled", async () => {
        expect(Value.Check(presenceModuleOptionsSchema, {})).toBe(true);
        expect(() => new PresenceModule({ unknown: true } as never)).toThrow(
            "unknown or invalid keys",
        );
        expect(() => new PresenceModule({ maxSchedules: 0 } as never)).toThrow(
            "unknown or invalid keys",
        );
        expect(() => new PresenceModule({ maxPresences: 257 } as never)).toThrow(
            "unknown or invalid keys",
        );

        const database = moduleDatabase([], "presence-tools-default");
        await database.ready;
        try {
            const readonly = new PresenceModule();
            const hooks = await resolveModuleHooks(database.context, readonly);
            const readonlyTools = (await hooks.tools?.(database.context, {} as never)) ?? [];
            expect(readonlyTools.map((tool) => tool.name)).toEqual([
                "get_presence",
                "list_presences",
            ]);

            const mutable = new PresenceModule({ allowModelMutation: true });
            const mutableHooks = await resolveModuleHooks(database.context, mutable);
            const tools = (await mutableHooks.tools?.(database.context, {} as never)) ?? [];
            expect(tools.map((tool) => tool.name)).toEqual([
                "get_presence",
                "list_presences",
                "set_presence",
            ]);
            expect(
                tools.every((tool) => tool.shouldReviewInAutoMode({}, database.context) === false),
            ).toBe(true);
            expect(tools.find((tool) => tool.name === "set_presence")).toMatchObject({
                durable: true,
                transactional: true,
            });
        } finally {
            database.close();
        }
    });

    it("rejects malformed injected clock results at every read boundary", async () => {
        for (const [name, value] of [
            ["negative", -1],
            ["fractional", 1.5],
            ["too-large", 8_640_000_000_000_001],
        ] as const) {
            const module = new PresenceModule({
                clock: () => value as never,
            });
            const database = moduleDatabase([], `presence-clock-${name}`);
            await database.ready;
            try {
                await expect(module.read(database.context)).rejects.toThrow("clock");
            } finally {
                database.close();
            }
        }
    });

    it("writes an initial state once, defaults temporary initial fallback to online, and preserves it after reload", async () => {
        let now = 100;
        const first = new PresenceModule({
            clock: () => now,
            initialState: {
                presenceId: "away",
                expiresAt: 200,
            },
        });
        const database = moduleDatabase(first.migrations, "presence-initial-state");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            expect(await first.read(database.context)).toMatchObject({
                presenceId: "away",
                expiresAt: 200,
                fallbackPresenceId: "online",
            });
            now = 200;
            expect(await first.read(database.context)).toMatchObject({
                presenceId: "online",
                status: "online",
            });

            const second = new PresenceModule({
                clock: () => 100,
                initialState: { presenceId: "offline" },
            });
            await second.beforeStart?.(database.context);
            expect(await second.read(database.context)).toMatchObject({
                presenceId: "away",
                status: "away",
            });
        } finally {
            database.close();
        }
    });

    it("rejects unknown selections, invalid expiry, and mismatched fallback inputs without writing", async () => {
        let now = 1_000;
        const module = new PresenceModule({ clock: () => now, catalog: [focus] });
        const database = moduleDatabase(module.migrations, "presence-invalid-mutations");
        await database.ready;
        try {
            await expect(
                module.setPresence(database.context, { presenceId: "missing" }),
            ).rejects.toThrow('There is no presence called "missing"');
            await expect(module.read(database.context)).resolves.toBeUndefined();
            await expect(
                module.setPresence(database.context, {
                    presenceId: "focus",
                    effectiveFrom: 0,
                    expiresAt: now,
                }),
            ).rejects.toThrow("future");
            await expect(
                module.setTemporary(database.context, {
                    presenceId: "focus",
                    expiresAt: now + 10,
                    effectiveFrom: now + 20,
                }),
            ).rejects.toThrow("expiry must be after");
            await expect(
                module.setPresence(database.context, {
                    presenceId: "focus",
                    fallbackPresenceId: "online",
                    fallback: { presenceId: "missing" },
                }),
            ).rejects.toThrow("disagree");
            await expect(
                module.setPresence(database.context, {
                    status: "custom",
                    presenceId: "focus",
                    fallbackPresenceId: "missing",
                }),
            ).rejects.toThrow('There is no presence called "missing"');
        } finally {
            database.close();
        }
    });

    it("keeps future effective states hidden until their start and returns the fallback after expiry", async () => {
        let now = 1_000;
        const module = new PresenceModule({ clock: () => now, catalog: [focus] });
        const database = moduleDatabase(module.migrations, "presence-effective-boundaries");
        await database.ready;
        try {
            await module.setPresence(database.context, {
                presenceId: "focus",
                message: "starting later",
                effectiveFrom: 2_000,
                expiresAt: 3_000,
                fallbackPresenceId: "online",
            });
            await expect(module.read(database.context)).resolves.toBeUndefined();
            now = 2_000;
            await expect(module.read(database.context)).resolves.toMatchObject({
                presenceId: "focus",
                message: "starting later",
                effectiveFrom: 2_000,
                expiresAt: 3_000,
                changesAt: 3_000,
                fallback: { presenceId: "online" },
            });
            now = 3_000;
            await expect(module.read(database.context)).resolves.toMatchObject({
                presenceId: "online",
                effectiveFrom: 3_000,
            });
        } finally {
            database.close();
        }
    });

    it("treats repeated identical mutations and clears as no-ops without publishing events", async () => {
        const eventTypes: string[] = [];
        const module = new PresenceModule({
            clock: () => 100,
            listener: {
                onEvent: (_ctx, event) => {
                    eventTypes.push(event.type);
                },
            },
        });
        const database = moduleDatabase(module.migrations, "presence-no-op-events");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "away" });
            await module.setPresence(database.context, { status: "away" });
            await module.clear(database.context);
            await module.clear(database.context);
            expect(eventTypes).toEqual(["presence_changed", "presence_cleared"]);
        } finally {
            database.close();
        }
    });

    it("persists custom definitions, denies clearing built-ins or configured entries, and reloads them", async () => {
        const module = new PresenceModule({ catalog: [focus], clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-definition-lifecycle");
        await database.ready;
        try {
            await expect(
                module.setPresenceDefinition(database.context, { ...focus, id: "online" }),
            ).rejects.toThrow("cannot be replaced");
            await expect(
                module.clearPresenceDefinition(database.context, "online"),
            ).rejects.toThrow("cannot be cleared");
            await expect(module.clearPresenceDefinition(database.context, "focus")).rejects.toThrow(
                "cannot be cleared",
            );

            await module.setPresenceDefinition(database.context, {
                ...focus,
                id: "meeting",
                title: "Meeting",
                emoji: "📅",
            });
            expect(await module.listPresences(database.context)).toContainEqual(
                expect.objectContaining({ id: "meeting", title: "Meeting" }),
            );
            await expect(module.clearPresenceDefinition(database.context, "meeting")).resolves.toBe(
                true,
            );
            await expect(module.clearPresenceDefinition(database.context, "meeting")).resolves.toBe(
                false,
            );

            await module.setPresenceDefinition(database.context, {
                ...focus,
                id: "meeting",
            });
            const restarted = new PresenceModule({ clock: () => 100 });
            expect(await restarted.listPresences(database.context)).toContainEqual(
                expect.objectContaining({ id: "meeting" }),
            );
        } finally {
            database.close();
        }
    });

    it("rejects clearing the active custom definition but keeps a detached caller result", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-definition-active");
        await database.ready;
        try {
            const definition = await module.setPresenceDefinition(database.context, focus);
            definition.title = "caller mutation";
            expect(await module.listPresences(database.context)).toContainEqual(focus);
            await module.setPresence(database.context, { presenceId: "focus" });
            await expect(module.clearPresenceDefinition(database.context, "focus")).rejects.toThrow(
                "active presence",
            );
        } finally {
            database.close();
        }
    });

    it("normalizes schedule days, deduplicates identical schedules, validates references, and enforces limits", async () => {
        const events: string[] = [];
        const module = new PresenceModule({
            clock: () => Date.parse("2024-01-01T10:00:00Z"),
            maxSchedules: 1,
            listener: {
                onEvent: (_ctx, event) => {
                    events.push(event.type);
                },
            },
        });
        const database = moduleDatabase(module.migrations, "presence-schedule-module");
        await database.ready;
        try {
            const first = await module.setSchedule(database.context, {
                ...schedule({ days: [3, 1] }),
            });
            expect(first.days).toEqual([1, 3]);
            await expect(
                module.setSchedule(database.context, { ...schedule({ days: [1, 3] }) }),
            ).resolves.toEqual(first);
            await expect(
                module.setSchedule(database.context, {
                    ...schedule({ days: [2], presence: { presenceId: "missing" } }),
                }),
            ).rejects.toThrow("There is no presence called");
            await expect(
                module.setSchedule(database.context, {
                    ...schedule({ days: [2], startTime: "18:00" }),
                }),
            ).rejects.toThrow("schedule limit");
            expect(events).toEqual(["presence_schedule_set"]);
            await expect(module.clearSchedule(database.context, first.id)).resolves.toBe(true);
            await expect(module.clearSchedule(database.context, first.id)).resolves.toBe(false);
            expect(events).toEqual(["presence_schedule_set", "presence_schedule_cleared"]);
        } finally {
            database.close();
        }
    });

    it("rejects invalid time zones before persisting a schedule", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-invalid-time-zone");
        await database.ready;
        try {
            await expect(
                module.setSchedule(database.context, {
                    ...schedule(),
                    timeZone: "Not/A/Timezone",
                }),
            ).rejects.toThrow();
            await expect(module.listSchedules(database.context)).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("rejects an invalid time zone even when a configured state would mask schedule evaluation", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-invalid-time-zone-masked");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "online" });
            await expect(
                module.setSchedule(database.context, {
                    ...schedule(),
                    timeZone: "Not/A/Timezone",
                }),
            ).rejects.toThrow();
            await expect(module.listSchedules(database.context)).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("gives configured state precedence over schedules, then exposes the schedule after clear", async () => {
        const module = new PresenceModule({
            clock: () => Date.parse("2024-01-01T10:00:00Z"),
        });
        const database = moduleDatabase(module.migrations, "presence-schedule-precedence");
        await database.ready;
        try {
            await module.setSchedule(database.context, schedule({ presence: { status: "away" } }));
            await module.setPresence(database.context, { status: "offline" });
            await expect(module.read(database.context)).resolves.toMatchObject({
                status: "offline",
            });
            await module.clear(database.context);
            await expect(module.read(database.context)).resolves.toMatchObject({
                status: "away",
            });
        } finally {
            database.close();
        }
    });

    it("delivers one deeply frozen event instance to transactional and post-commit listeners", async () => {
        let transactionalEvent: object | undefined;
        let postCommitEvent: object | undefined;
        const module = new PresenceModule({
            clock: () => 100,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactionalEvent = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type === "presence_changed") {
                        expect(Object.isFrozen(event.previous)).toBe(true);
                        expect(Object.isFrozen(event.current)).toBe(true);
                    }
                },
                onEvent: (_ctx, event) => {
                    postCommitEvent = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type === "presence_changed") {
                        expect(Object.isFrozen(event.current)).toBe(true);
                    }
                },
            },
        });
        const database = moduleDatabase(module.migrations, "presence-event-freeze");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "away" });
            expect(postCommitEvent).toBe(transactionalEvent);
            expect(transactionalEvent).toMatchObject({
                type: "presence_changed",
                at: 100,
                current: { presenceId: "away" },
                previous: null,
            });
        } finally {
            database.close();
        }
    });

    it("emits validated event variants for definitions, schedules, and state transitions", async () => {
        const events: unknown[] = [];
        const module = new PresenceModule({
            clock: () => 100,
            listener: {
                onEvent: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        const database = moduleDatabase(module.migrations, "presence-event-variants");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, {
                ...focus,
                id: "meeting",
            });
            await module.clearPresenceDefinition(database.context, "meeting");
            const configured = await module.setSchedule(database.context, schedule());
            await module.clearSchedule(database.context, configured.id);
            await module.setPresence(database.context, { status: "away" });
            await module.clear(database.context);
            expect(events.map((event) => (event as { type: string }).type)).toEqual([
                "presence_definition_set",
                "presence_definition_cleared",
                "presence_schedule_set",
                "presence_schedule_cleared",
                "presence_changed",
                "presence_cleared",
            ]);
            expect(events.every((event) => Value.Check(presenceEventSchema, event))).toBe(true);
        } finally {
            database.close();
        }
    });

    it("invokes class-backed listener methods with their owning receiver", async () => {
        class Listener {
            readonly #seen: string[] = [];

            onEventTransactional(_ctx: unknown, event: { readonly type: string }): void {
                this.#seen.push(`tx:${event.type}`);
            }

            onEvent(_ctx: unknown, event: { readonly type: string }): void {
                this.#seen.push(`post:${event.type}`);
            }

            get seen(): readonly string[] {
                return this.#seen;
            }
        }
        const listener = new Listener();
        const module = new PresenceModule({ listener });
        const database = moduleDatabase(module.migrations, "presence-class-listener");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "away" });
            expect(listener.seen).toEqual(["tx:presence_changed", "post:presence_changed"]);
        } finally {
            database.close();
        }
    });

    it("publishes no post-commit event or durable state after an outer rollback", async () => {
        const transactional: string[] = [];
        const committed: string[] = [];
        const module = new PresenceModule({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event.type);
                },
                onEvent: (_ctx, event) => {
                    committed.push(event.type);
                },
            },
        });
        const database = moduleDatabase(module.migrations, "presence-outer-rollback");
        await database.ready;
        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await module.setPresence(txCtx, { status: "away" });
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");
            expect(transactional).toEqual(["presence_changed"]);
            expect(committed).toEqual([]);
            await expect(module.read(database.context)).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rolls back a mutation when the transactional listener fails", async () => {
        const committed: string[] = [];
        const module = new PresenceModule({
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject presence");
                },
                onEvent: (_ctx, event) => {
                    committed.push(event.type);
                },
            },
        });
        const database = moduleDatabase(module.migrations, "presence-transactional-failure");
        await database.ready;
        try {
            await expect(module.setPresence(database.context, { status: "away" })).rejects.toThrow(
                "reject presence",
            );
            expect(committed).toEqual([]);
            await expect(module.read(database.context)).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains post-commit listener and error-reporter failures after durable commit", async () => {
        const reports: unknown[] = [];
        const module = new PresenceModule({
            listener: {
                onEvent: () => {
                    throw { message: "hostile", toString: () => "hostile" };
                },
            },
            onPostCommitError: (_ctx, _event, error) => {
                reports.push(error);
                throw new Error("reporter failed");
            },
        });
        const database = moduleDatabase(module.migrations, "presence-postcommit-failure");
        await database.ready;
        try {
            await expect(
                module.setPresence(database.context, { status: "away" }),
            ).resolves.toMatchObject({ status: "away" });
            expect(reports).toHaveLength(1);
            await expect(module.read(database.context)).resolves.toMatchObject({
                status: "away",
            });
        } finally {
            database.close();
        }
    });

    it("subscribes with an initial snapshot, re-arms on changes, and removes failing subscribers", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-user-input-policy");
        await database.ready;
        try {
            expect(Value.Check(presenceUserInputPolicySchema, module.userInputPolicy)).toBe(true);
            const snapshots: unknown[] = [];
            const unsubscribe = await module.userInputPolicy.subscribe(
                database.context,
                "agent-1",
                (_ctx, state) => {
                    snapshots.push(state);
                },
            );
            expect(snapshots).toEqual([undefined]);
            await module.setPresence(database.context, { status: "away" });
            await vi.waitFor(() =>
                expect(snapshots).toEqual([
                    undefined,
                    {
                        answerWaitMs: 0,
                        title: "Away",
                        emoji: "🌙",
                        prompt: AWAY_PRESENCE.prompt,
                    },
                ]),
            );
            unsubscribe?.();
            await module.setPresence(database.context, { status: "online" });
            expect(snapshots).toHaveLength(2);

            const failing = vi.fn(() => {
                throw new Error("subscriber failed");
            });
            await expect(
                module.userInputPolicy.subscribe(database.context, "agent-1", failing),
            ).rejects.toThrow("subscriber failed");
            await module.setPresence(database.context, { status: "dnd" });
            expect(failing).toHaveBeenCalledOnce();
        } finally {
            database.close();
        }
    });

    it("keeps public operations and model tools on one state implementation", async () => {
        let now = 1_000;
        const module = new PresenceModule({
            allowModelMutation: true,
            catalog: [focus],
            clock: () => now,
        });
        const database = moduleDatabase(module.migrations, "presence-tool-parity");
        await database.ready;
        try {
            const get = getPresenceTool(module);
            const list = listPresenceTool(module);
            const set = setPresenceTool(module);
            expect(await get.execute(database.context, {} as never, {} as never)).toEqual({
                presence: null,
            });
            const first = await set.execute(
                database.context,
                {
                    input: {
                        presenceId: "focus",
                        message: "deep work",
                        until: 2_000,
                        fallbackPresenceId: "online",
                    },
                },
                { id: "call-1", providerCallId: "provider-1" } as never,
            );
            expect(Value.Check(presenceStateSchema, first.presence)).toBe(true);
            expect(await module.read(database.context)).toEqual(first.presence);
            expect(
                llmText(
                    get.toLLM({
                        presence: first.presence,
                    }),
                ),
            ).toContain("wait 15 minutes");
            expect(llmText(set.toLLM(first))).toContain("Presence set to Focus 🎧");
            const listed = await list.execute(database.context, {} as never, {} as never);
            expect(listed.presences).toContainEqual(focus);
            expect(llmText(list.toLLM(listed))).toContain("focus: Focus 🎧");

            now = 2_000;
            const expired = await get.execute(database.context, {} as never, {} as never);
            expect(expired.presence).toMatchObject({ status: "online" });
            expect(llmText(get.toLLM(expired))).toContain("wait indefinitely");
        } finally {
            database.close();
        }
    });

    it("keeps large model catalogs within the tool's explicit output bound", async () => {
        const catalog = Array.from({ length: 60 }, (_, index) => ({
            ...focus,
            id: `focus-${index}`,
            prompt: "p".repeat(2_000),
        }));
        const module = new PresenceModule({
            catalog,
            maxPresences: 64,
        });
        const database = moduleDatabase(module.migrations, "presence-catalog-output-bound");
        await database.ready;
        try {
            const tool = listPresenceTool(module);
            const result = await tool.execute(database.context, {} as never, {} as never);
            const output = llmText(tool.toLLM(result));
            expect(output.length).toBeLessThanOrEqual(100_000);
            expect(output).toContain("detailed prompts were omitted");
            expect(output).toContain("focus-0");
        } finally {
            database.close();
        }
    });

    it("does not allow a custom definition referenced by a future fallback to disappear", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-fallback-definition");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, focus);
            await module.setPresence(database.context, {
                status: "away",
                expiresAt: 200,
                fallbackPresenceId: "focus",
            });
            await expect(
                module.clearPresenceDefinition(database.context, "focus"),
            ).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("does not allow a custom definition referenced by a schedule to disappear", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-schedule-definition");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, focus);
            await module.setSchedule(database.context, {
                ...schedule(),
                presence: { presenceId: "focus" },
            });
            await expect(
                module.clearPresenceDefinition(database.context, "focus"),
            ).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("does not override a built-in definition with a custom constructor catalog", () => {
        expect(
            () =>
                new PresenceModule({
                    catalog: [
                        {
                            ...focus,
                            id: "online",
                            title: "Fake Online",
                        },
                    ],
                }),
        ).toThrow();
    });

    it("rejects a catalog bound that cannot contain the immutable built-ins", () => {
        expect(() => new PresenceModule({ maxPresences: 3 })).toThrow();
    });

    it("keeps catalog and schedule reads bounded at configured limits", async () => {
        const module = new PresenceModule({ maxPresences: 5, maxSchedules: 1 });
        const database = moduleDatabase(module.migrations, "presence-bounds");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, focus);
            await expect(
                module.setPresenceDefinition(database.context, { ...focus, id: "other" }),
            ).rejects.toThrow("catalog limit");
            await module.setSchedule(database.context, schedule());
            await expect(module.listSchedules(database.context)).resolves.toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted schedules and state through the module boundary", async () => {
        const module = new PresenceModule({ clock: () => 100 });
        const database = moduleDatabase(module.migrations, "presence-module-malformed");
        await database.ready;
        try {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_presence_schedules (id, schedule_json)
                    VALUES (${"malformed"}, ${JSON.stringify({
                        id: "malformed",
                        days: [2, 1],
                        startTime: "09:00",
                        endTime: "17:00",
                        timeZone: "UTC",
                        presence: { status: "away" },
                    })})`,
            );
            await expect(module.listSchedules(database.context)).rejects.toThrow("canonical");
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_presence (singleton_id, state_json)
                    VALUES (1, ${JSON.stringify({
                        presenceId: "unknown",
                    })})`,
            );
            await expect(module.read(database.context)).rejects.toThrow("not configured");
        } finally {
            database.close();
        }
    });
});
