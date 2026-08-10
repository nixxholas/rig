import { defineModel } from "@slopus/rig-execution";
import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { createEventIdFactory } from "../../protocol/index.js";
import { InMemorySession, type InMemorySessionPersistence } from "../InMemorySession.js";

describe("InMemorySession markRead", () => {
    it("does not open a transaction when a focused terminal repeats an already-applied mark", async () => {
        const ctx = createTestRootContext();
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/mark-read-fast-path",
            name: "Mark read fast path",
            thinkingLevels: ["off"],
        });
        const modelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: "test",
            models: [model],
            providers: [{ models: [model], providerId: "test" }],
        };
        const request = {
            cwd: "/tmp/rig-mark-read-fast-path",
            modelId: model.id,
            trackUnread: true,
        };
        const seed = await InMemorySession.open(ctx, {
            createEventId: createEventIdFactory(),
            emitCreatedEvent: false,
            modelCatalog,
            request,
        });
        const transaction = vi.fn(
            async <T>(transactionCtx: typeof ctx, body: (bodyCtx: typeof ctx) => T | Promise<T>) =>
                await body(transactionCtx),
        );
        const persistence = {
            saveSession: vi.fn(async () => undefined),
            transaction,
        } as unknown as InMemorySessionPersistence;
        const session = await InMemorySession.open(ctx, {
            createEventId: createEventIdFactory(),
            emitCreatedEvent: false,
            modelCatalog,
            persistence,
            request,
            restore: {
                ...seed.state(),
                unread: { reason: "attention_needed", since: 123 },
            },
        });
        transaction.mockClear();

        await expect(session.markRead(ctx)).resolves.toBe(true);
        await expect(session.markRead(ctx)).resolves.toBe(false);

        expect(transaction).toHaveBeenCalledOnce();
    });
});
