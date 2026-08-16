import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AutoEvidenceEntry } from "../../sources/auto/AutoReviewTranscript.js";
import type { AutoTranscriptMessage } from "../../sources/auto/impl/createAutoPermissionTranscript.js";
import { AutoReviewEvidenceStore } from "../../sources/auto/impl/AutoReviewEvidenceStore.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import type { AgentDatabase } from "@slopus/happy-agent-base";

const AGENT = "agent-1";

function messageEntry(text: string, trusted = false): AutoEvidenceEntry {
    const entry: AutoTranscriptMessage = { role: "user", blocks: [{ type: "text", text }] };
    return {
        category: "message",
        entry,
        trustedUserEvidence: trusted,
        trustedUserEvidenceTruncated: false,
    };
}

describe("AutoReviewEvidenceStore", () => {
    let store: AutoReviewEvidenceStore;
    let db: ModuleDatabase & { readonly database: AgentDatabase };

    beforeEach(async () => {
        store = new AutoReviewEvidenceStore();
        db = moduleDatabase(store.migrations, "auto-evidence");
        await db.ready;
    });

    afterEach(() => {
        db.close();
    });

    it("reports a fresh healthy generation-zero state for an unseen agent", async () => {
        expect(await store.readState(db.database, AGENT)).toEqual({
            generation: 0,
            nextPosition: 0,
            archiveHealthy: true,
        });
    });

    it("appends entries and advances the cursor in order", async () => {
        await store.appendEntry(db.database, AGENT, messageEntry("first"));
        await store.appendEntry(db.database, AGENT, messageEntry("second"));

        expect(await store.readState(db.database, AGENT)).toMatchObject({
            generation: 0,
            nextPosition: 2,
            archiveHealthy: true,
        });
        const entries = await store.readEntries(db.database, AGENT, 0);
        expect(entries.map((entry) => entry.blocks[0])).toEqual([
            { type: "text", text: "first" },
            { type: "text", text: "second" },
        ]);
    });

    it("marks the archive unhealthy so a later review fails closed", async () => {
        await store.markUnhealthy(db.database, AGENT);
        expect((await store.readState(db.database, AGENT)).archiveHealthy).toBe(false);
    });

    it("bumps the generation, clears old rows, and resets position", async () => {
        await store.appendEntry(db.database, AGENT, messageEntry("gen-zero"));
        await store.bumpGeneration(db.database, AGENT);

        expect(await store.readState(db.database, AGENT)).toEqual({
            generation: 1,
            nextPosition: 0,
            archiveHealthy: true,
        });
        expect(await store.readEntries(db.database, AGENT, 0)).toEqual([]);

        await store.appendEntry(db.database, AGENT, messageEntry("gen-one"));
        const entries = await store.readEntries(db.database, AGENT, 1);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.blocks[0]).toEqual({ type: "text", text: "gen-one" });
    });

    it("round-trips a recorded human answer and upserts on the same call id", async () => {
        const first: AutoTranscriptMessage = { role: "user", blocks: [{ type: "text", text: "yes" }] };
        await store.recordUserAnswer(db.database, AGENT, "call-1", first);
        expect(await store.readUserAnswer(db.database, AGENT, "call-1")).toEqual(first);

        const revised: AutoTranscriptMessage = {
            role: "user",
            blocks: [{ type: "text", text: "actually no" }],
        };
        await store.recordUserAnswer(db.database, AGENT, "call-1", revised);
        expect(await store.readUserAnswer(db.database, AGENT, "call-1")).toEqual(revised);
    });

    it("returns undefined for an unrecorded answer", async () => {
        expect(await store.readUserAnswer(db.database, AGENT, "missing")).toBeUndefined();
    });
});
