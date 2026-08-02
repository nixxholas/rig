import { describe, expect, it, vi } from "vitest";

import type { Attachment } from "../../protocol/Attachment.js";
import { AttachmentContext } from "./AttachmentContext.js";

const fileAttachment = (id: string, source: string): Attachment => ({
    bytes: 4,
    id,
    kind: "file",
    name: "result.txt",
    source,
});

describe("AttachmentContext", () => {
    it("deduplicates concurrent preparation and releases a removed source", async () => {
        const context = new AttachmentContext({ idFactory: () => "attachment-1" });
        const prepare = vi.fn(async (id: string) => fileAttachment(id, "/workspace/result.txt"));

        const [first, duplicate] = await Promise.all([
            context.add("/workspace/result.txt", prepare),
            context.add("/workspace/result.txt", prepare),
        ]);

        expect(first).toBe(duplicate);
        expect(prepare).toHaveBeenCalledOnce();
        expect(context.remove(first.id)).toBe(true);
        await context.add("/workspace/result.txt", prepare);
        expect(prepare).toHaveBeenCalledTimes(2);
    });

    it("retains cleanup on discard but not after committing pending items", async () => {
        const cleanup = vi.fn();
        const discarded = new AttachmentContext({ idFactory: () => "discarded" });
        await discarded.add("one", async (id) => fileAttachment(id, "one"));
        discarded.registerCleanup("discarded", cleanup);
        discarded.discard();
        await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());

        const committed = new AttachmentContext({ idFactory: () => "committed" });
        await committed.add("two", async (id) => fileAttachment(id, "two"));
        committed.registerCleanup("committed", cleanup);
        expect(committed.takePending()).toHaveLength(1);
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it("does not revive an attachment whose preparation finishes after discard", async () => {
        const context = new AttachmentContext({ idFactory: () => "slow" });
        let release!: () => void;
        const prepared = context.add(
            "slow-source",
            (id) =>
                new Promise<Attachment>((resolve) => {
                    release = () => resolve(fileAttachment(id, "slow-source"));
                }),
        );

        context.discard();
        release();
        await prepared;

        expect(context.pending()).toEqual([]);
    });

    it("runs every registered cleanup when preparation rejects", async () => {
        const context = new AttachmentContext({ idFactory: () => "failed" });
        const first = vi.fn();
        const second = vi.fn();

        await expect(
            context.add("failed-source", async (id) => {
                context.registerCleanup(id, first);
                context.registerCleanup(id, second);
                throw new Error("preparation failed");
            }),
        ).rejects.toThrow("preparation failed");

        await vi.waitFor(() => {
            expect(first).toHaveBeenCalledOnce();
            expect(second).toHaveBeenCalledOnce();
        });
    });
});
