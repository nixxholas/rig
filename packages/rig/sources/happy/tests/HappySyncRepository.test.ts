import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { sessions } from "../../persistence/database/schema.js";
import { createSessionDatabaseFixture } from "../../persistence/database/tests/createSessionDatabaseFixture.js";
import { HappySyncRepository } from "../HappySyncRepository.js";
import { isDatabaseFailure } from "../../persistence/isDatabaseFailure.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

const directories: string[] = [];
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;
const ctx = createTestRootContext().named("happy-sync-repository-test");

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("HappySyncRepository", () => {
    it("acknowledges the Happy outbox with the operation context", async () => {
        const ctx = createTestRootContext().named("happy-outbox-acknowledge");
        const { repository } = await createRepository();
        const message = createMessage("message-1");

        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.enqueue(ctx, "session-1", [message]);
        await repository.acknowledge(ctx, "session-1", [message.localId]);

        expect(await repository.pending(ctx, "session-1")).toEqual([]);
        await repository.close(ctx);
    });

    it("rejects new messages without deleting pending delivery work when the outbox is full", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.close(ctx);
        const bounded = await HappySyncRepository.open(
            createTestRootContext(),
            databasePath,
            Date.now,
            2,
        );
        const first = createMessage("message-1");
        const second = createMessage("message-2");
        await bounded.enqueue(ctx, "session-1", [first, second]);

        await expect(
            bounded.enqueue(ctx, "session-1", [createMessage("message-3")]),
        ).rejects.toThrow("Happy sync outbox is full");
        expect(await bounded.pending(ctx, "session-1")).toEqual([first, second]);
        await bounded.close(ctx);
    });

    it("keeps a random session key and remote cursor across daemon restarts", async () => {
        const { databasePath, repository } = await createRepository();
        const first = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.setRemoteSession(ctx, "session-1", "remote-1");
        await repository.updateLastRemoteSeq(ctx, "session-1", 12);
        await repository.close(ctx);

        const reopened = await HappySyncRepository.open(createTestRootContext(), databasePath);
        const second = await reopened.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(second.encryptionKey).toEqual(first.encryptionKey);
        expect(second).toMatchObject({ lastRemoteSeq: 12, remoteSessionId: "remote-1" });
        await reopened.close(ctx);
    });

    it("never moves the remote sequence backwards", async () => {
        const { repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        await repository.updateLastRemoteSeq(ctx, "session-1", 12);
        await repository.updateLastRemoteSeq(ctx, "session-1", 5);

        expect((await repository.getSession(ctx, "session-1"))?.lastRemoteSeq).toBe(12);
        await repository.close(ctx);
    });

    it("rotates remote state when the authenticated Happy account changes", async () => {
        const { repository } = await createRepository();
        const first = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        await repository.setRemoteSession(ctx, "session-1", "remote-1");
        await repository.enqueue(ctx, "session-1", [createMessage("encrypted-for-account-1")]);

        const rotated = await repository.ensureSession(ctx, {
            credentialFingerprint: "account-2",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(rotated.remoteSessionId).toBeUndefined();
        expect(rotated.encryptionKey).not.toEqual(first.encryptionKey);
        expect(await repository.pending(ctx, "session-1")).toEqual([]);
        await repository.close(ctx);
    });

    it("lists only sessions mapped for the active Happy credentials", async () => {
        const { repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });

        expect(await repository.sessionIds(ctx, "account-1", { activeSinceMs: 0 })).toEqual([
            "session-1",
        ]);
        expect(await repository.sessionIds(ctx, "account-2", { activeSinceMs: 0 })).toEqual([]);
        await repository.close(ctx);
    });

    it("restores only live, recently active sessions and keeps the batch bounded", async () => {
        const { databasePath, repository } = await createRepository(() => NOW);
        await insertSessions(databasePath, [
            { archived: true, id: "archived", updatedAtMs: NOW - HOUR_MS },
            { id: "subagent", sessionKind: "subagent", updatedAtMs: NOW - HOUR_MS },
            { id: "stale", updatedAtMs: NOW - 30 * DAY_MS },
            { id: "recent", updatedAtMs: NOW - 2 * DAY_MS },
            { id: "chatting", lastMessageAtMs: NOW - HOUR_MS, updatedAtMs: NOW - 30 * DAY_MS },
        ]);
        for (const sessionId of [
            "archived",
            "chatting",
            "recent",
            "session-1",
            "stale",
            "subagent",
        ]) {
            await repository.ensureSession(ctx, {
                credentialFingerprint: "account-1",
                encryptionVariant: "dataKey",
                sessionId,
            });
        }

        expect(await repository.sessionIds(ctx, "account-1")).toEqual(["chatting", "recent"]);
        expect(await repository.sessionIds(ctx, "account-1", { limit: 1 })).toEqual(["chatting"]);
        expect(await repository.sessionIds(ctx, "account-1", { activeSinceMs: 0 })).toEqual([
            "chatting",
            "recent",
            "stale",
            "session-1",
        ]);
        await repository.close(ctx);
    });

    it("rolls back session rotation when clearing the stale outbox fails", async () => {
        const { databasePath, repository } = await createRepository();
        await repository.ensureSession(ctx, {
            credentialFingerprint: "account-1",
            encryptionVariant: "dataKey",
            sessionId: "session-1",
        });
        const pending = createMessage("encrypted-for-account-1");
        await repository.enqueue(ctx, "session-1", [pending]);
        await repository.close(ctx);

        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        await opened.ctx.tx.run(
            sql.raw(`
            CREATE TRIGGER reject_happy_outbox_delete
            BEFORE DELETE ON happy_outbox
            BEGIN
                SELECT RAISE(ABORT, 'forced outbox delete failure');
            END
        `),
        );
        await opened.database.close(opened.ctx);

        const reopened = await HappySyncRepository.open(createTestRootContext(), databasePath);
        const failure = await reopened
            .ensureSession(ctx, {
                credentialFingerprint: "account-2",
                encryptionKey: new Uint8Array(32).fill(2),
                encryptionVariant: "dataKey",
                sessionId: "session-1",
            })
            .then(
                () => undefined,
                (error: unknown) => error,
            );
        expect(isDatabaseFailure(failure)).toBe(true);
        expect((await reopened.getSession(ctx, "session-1"))?.credentialFingerprint).toBe(
            "account-1",
        );
        expect(await reopened.pending(ctx, "session-1")).toEqual([pending]);
        await reopened.close(ctx);
    });
});

function createMessage(localId: string) {
    return {
        content: {
            ev: { t: "service" as const, text: localId },
            id: localId,
            role: "agent" as const,
            time: 1,
        },
        localId,
        meta: { sentFrom: "rig" as const },
        role: "session" as const,
    };
}

async function createRepository(now: () => number = Date.now) {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-repository-"));
    directories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    await createSessionDatabaseFixture(databasePath);
    return {
        databasePath,
        repository: await HappySyncRepository.open(createTestRootContext(), databasePath, now),
    };
}

/*
 * The restore query joins the owning session rows, so the scope it has to reject
 * only exists once those rows do.
 */
async function insertSessions(
    databasePath: string,
    rows: readonly {
        archived?: boolean;
        id: string;
        lastMessageAtMs?: number;
        sessionKind?: string;
        updatedAtMs: number;
    }[],
): Promise<void> {
    const opened = await openSessionDatabase(createTestRootContext(), databasePath);
    for (const row of rows) {
        await opened.ctx.tx
            .insert(sessions)
            .values({
                agentId: `agent-${row.id}`,
                archived: row.archived ?? false,
                createdAtMs: 1,
                cwd: "/workspace",
                depth: 0,
                durableSkillsJson: "[]",
                elapsedMs: 0,
                externalToolsJson: "[]",
                id: row.id,
                interrupted: false,
                ...(row.lastMessageAtMs === undefined
                    ? {}
                    : { lastMessageAtMs: row.lastMessageAtMs }),
                modelId: "model",
                ownerInstanceId: "alocalinstance00000000001",
                modelsJson: "[]",
                nextTaskId: 1,
                orderKey: `a-${row.id}`,
                permissionMode: "workspace_write",
                projectId: "project-1",
                providerId: "codex",
                rootSessionId: row.id,
                secretIdsJson: "[]",
                sessionKind: row.sessionKind ?? "primary",
                status: "idle",
                tasksJson: "[]",
                titleStatus: "idle",
                toolsJson: "[]",
                totalTokens: 0,
                trackUnread: false,
                updatedAtMs: row.updatedAtMs,
                workflowsEnabled: true,
                workflowsJson: "[]",
            })
            .run();
    }
    await opened.database.close(opened.ctx);
}
