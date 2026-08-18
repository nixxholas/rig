import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { ApiEventJournal, apiEventSchema } from "../../sources/api/ApiEventJournal.js";

describe("ApiEventJournal", () => {
    it("reads from the oldest retained event when after is omitted", () => {
        const journal = new ApiEventJournal(10, () => 1_755_400_000_000);
        const first = journal.append("project.created", { project: { id: "p1" } });
        const second = journal.append("project.updated", { projectId: "p1" });

        const page = journal.replay(undefined, undefined, 10);

        expect(page?.events).toEqual([first, second]);
        expect(page?.cursor).toBe(second.cursor);
        expect(page?.latestCursor).toBe(second.cursor);
        expect(Value.Check(apiEventSchema, first)).toBe(true);
    });

    it("uses exclusive after and inclusive until bounds", () => {
        const journal = new ApiEventJournal(10, () => 1_755_400_000_000);
        const first = journal.append("project.created", {});
        const second = journal.append("project.updated", {});
        journal.append("workspace.created", {});

        expect(journal.replay(first.cursor, second.cursor, 10)?.events).toEqual([second]);
    });

    it("reports a cursor outside the retained window as unavailable", () => {
        const journal = new ApiEventJournal(2, () => 1_755_400_000_000);
        const lost = journal.append("project.created", {});
        journal.append("project.updated", {});
        journal.append("workspace.created", {});
        journal.append("workspace.updated", {});

        expect(journal.hasCursor(lost.cursor)).toBe(false);
        expect(journal.replay(lost.cursor, undefined, 2)).toBeUndefined();
    });

    it("delivers immutable snapshots and releases subscriptions", () => {
        const journal = new ApiEventJournal(10, () => 1_755_400_000_000);
        const listener = vi.fn();
        const unsubscribe = journal.subscribe(listener);
        const payload = { changes: { name: "before" } };

        const event = journal.append("project.updated", payload);
        payload.changes.name = "after";
        unsubscribe();
        journal.append("project.updated", {});

        expect(listener).toHaveBeenCalledOnce();
        expect(event.payload).toEqual({ changes: { name: "before" } });
        expect(Object.isFrozen(event.payload)).toBe(true);
    });
});
