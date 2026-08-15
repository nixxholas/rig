import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Span, Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

describe("PersistentSessionStore request context", () => {
    const stores: PersistentSessionStore[] = [];

    afterEach(async () => {
        const ctx = createTestRootContext();
        await Promise.all(stores.splice(0).map((store) => store.close(ctx)));
    });

    it("creates a session without replacing the transaction context", async () => {
        const ctx = createTestRootContext();
        const store = await PersistentSessionStore.open(ctx, { databasePath: ":memory:" });
        stores.push(store);

        await expect(
            Promise.race([
                store.create(ctx, { cwd: "/tmp/rig-request-context" }),
                new Promise<never>((_resolve, reject) => {
                    setTimeout(
                        () => reject(new Error("Session creation waited on its own transaction.")),
                        1_000,
                    ).unref();
                }),
            ]),
        ).resolves.toBeDefined();
    });

    it("keeps the transaction context while persisting a session event", async () => {
        const ctx = createTestRootContext();
        const store = await PersistentSessionStore.open(ctx, { databasePath: ":memory:" });
        stores.push(store);
        const session = await store.create(ctx, { cwd: "/tmp/rig-event-context" });

        await expect(
            Promise.race([
                session.recordSystemNotice(ctx, { text: "Preparing the session." }),
                new Promise<never>((_resolve, reject) => {
                    setTimeout(
                        () => reject(new Error("Event persistence waited on its own transaction.")),
                        1_000,
                    ).unref();
                }),
            ]),
        ).resolves.toBeUndefined();
    });

    it("restores one client-facing session without loading its agent tree or rewriting it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-session-context-"));
        const databasePath = join(directory, "sessions.sqlite");
        const setupCtx = createTestRootContext();
        const setup = await PersistentSessionStore.open(setupCtx, { databasePath });
        await setup.createWithId(setupCtx, "session-1", { cwd: directory });
        await setup.close(setupCtx);

        const spanNames: string[] = [];
        const tracer = {
            startSpan(name: string) {
                spanNames.push(name);
                return testSpan();
            },
        } as unknown as Tracer;
        const ctx = createTestRootContext(tracer);
        const store = await PersistentSessionStore.open(ctx, { databasePath });
        try {
            spanNames.length = 0;
            await expect(
                store.get(ctx, "session-1", { loadAgentTree: false }),
            ).resolves.toBeDefined();
            expect(spanNames).not.toContain("rig.sql.session.query_agent_tree_session_ids");
            expect(spanNames).not.toContain("rig.sql.session.session_save");
        } finally {
            await store.close(ctx);
            await rm(directory, { force: true, recursive: true });
        }
    });
});

function testSpan(): Span {
    const span: Span = {
        addEvent: () => span,
        addLink: () => span,
        addLinks: () => span,
        end: () => undefined,
        isRecording: () => true,
        recordException: () => undefined,
        setAttribute: () => span,
        setAttributes: () => span,
        setStatus: () => span,
        spanContext: () => ({ spanId: "2".repeat(16), traceFlags: 1, traceId: "1".repeat(32) }),
        updateName: () => span,
    };
    return span;
}
