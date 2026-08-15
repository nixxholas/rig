import { createTestRootContext } from "../testing/createTestRootContext.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    HAPPY_CLOUD_CONTRACT_VERSION,
    isLiveGlobalEvent,
    type HappyCloudCommand,
} from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { HAPPY_CLOUD_SESSION_BLOB_LIMIT } from "../persistence/happy-cloud/happyCloudApplyCommand.js";

const directories: string[] = [];
const ctx = createTestRootContext().named("happy-cloud-service-test");

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("HappyCloudService", () => {
    it("starts denied, keeps enrollment separate, and persists independent choices across restart", async () => {
        const fixture = await createFixture();
        expect(await fixture.service.status(ctx)).toMatchObject({
            capabilities: {
                group_chats: { consent: "denied" },
                happy_profile: { consent: "denied" },
                remote_control: { consent: "denied" },
                session_blob_persistence: { consent: "denied" },
            },
            contractVersion: 1,
            enrollment: { state: "not_enrolled" },
            version: 0,
        });

        await fixture.apply({ action: "set_enrollment", state: "enrolled" });
        await fixture.apply({
            action: "set_capability",
            capability: "group_chats",
            consent: "granted",
        });
        await fixture.apply({
            action: "set_capability",
            capability: "remote_control",
            consent: "granted",
        });
        await fixture.store.close(ctx);

        const restarted = await PersistentSessionStore.open(ctx, {
            databasePath: fixture.path,
        });
        expect(await restarted.happyCloud.status(ctx)).toMatchObject({
            capabilities: {
                group_chats: { consent: "granted" },
                remote_control: { consent: "granted" },
            },
            enrollment: { state: "enrolled" },
            version: 3,
        });
        await restarted.close(ctx);
    });

    it("rejects capability and ciphertext changes before their explicit gates are granted", async () => {
        const fixture = await createFixture();
        await expect(
            fixture.apply({
                action: "set_capability",
                capability: "group_chats",
                consent: "granted",
            }),
        ).rejects.toThrow("Enroll in Happy Cloud");
        expect((await fixture.service.status(ctx)).version).toBe(0);
        await fixture.apply({ action: "set_enrollment", state: "enrolled" });
        await expect(
            fixture.apply({ action: "put_profile", ciphertext: "b3BhcXVl" }),
        ).rejects.toThrow("Grant the happy profile capability");
        await expect(
            fixture.apply({
                action: "put_session_blob",
                ciphertext: "b3BhcXVl",
                sessionId: "session-1",
            }),
        ).rejects.toThrow("Grant the session blob persistence capability");
        await fixture.store.close(ctx);
    });

    it("stores ciphertext verbatim and revocation removes only the affected encrypted data", async () => {
        const fixture = await createFixture();
        await fixture.apply({ action: "set_enrollment", state: "enrolled" });
        await fixture.apply({
            action: "set_capability",
            capability: "happy_profile",
            consent: "granted",
        });
        await fixture.apply({
            action: "set_capability",
            capability: "session_blob_persistence",
            consent: "granted",
        });
        const profile = "cHJvZmlsZV9jaXBoZXJ0ZXh0";
        const blob = "c2Vzc2lvbl9jaXBoZXJ0ZXh0";
        await fixture.apply({ action: "put_profile", ciphertext: profile });
        await fixture.apply({
            action: "put_session_blob",
            ciphertext: blob,
            sessionId: "mobile/session",
        });
        expect(await fixture.service.getProfile(ctx)).toEqual({ ciphertext: profile, version: 4 });
        expect((await fixture.service.getSessionBlob(ctx, "mobile/session"))?.ciphertext).toBe(
            blob,
        );

        await fixture.apply({
            action: "set_capability",
            capability: "group_chats",
            consent: "granted",
        });
        expect(await fixture.service.getProfile(ctx)).toEqual({ ciphertext: profile, version: 4 });

        await fixture.apply({
            action: "set_capability",
            capability: "happy_profile",
            consent: "denied",
        });
        expect(await fixture.service.getProfile(ctx)).toBeUndefined();
        expect((await fixture.service.getSessionBlob(ctx, "mobile/session"))?.ciphertext).toBe(
            blob,
        );

        await fixture.apply({ action: "set_enrollment", state: "not_enrolled" });
        expect(
            (await fixture.service.status(ctx)).capabilities.session_blob_persistence.consent,
        ).toBe("denied");
        expect(await fixture.service.getSessionBlob(ctx, "mobile/session")).toBeUndefined();
        await fixture.store.close(ctx);

        const database = createClient({ url: pathToFileURL(fixture.path).href });
        const receipts = (
            await database.execute(
                "SELECT request_fingerprint, response_json FROM happy_cloud_mutation_receipts",
            )
        ).rows as unknown as Array<{ request_fingerprint: string; response_json: string }>;
        expect(
            receipts.every((receipt) => /^[a-f0-9]{64}$/u.test(receipt.request_fingerprint)),
        ).toBe(true);
        expect(receipts.some((receipt) => receipt.response_json.includes(profile))).toBe(false);
        expect(receipts.some((receipt) => receipt.response_json.includes(blob))).toBe(false);
        await database.close();
    });

    it("is idempotent for exact duplicate mutations and rejects reuse or stale reordered commands", async () => {
        const fixture = await createFixture();
        const first = await fixture.command({
            action: "set_enrollment",
            state: "enrolled",
        });
        const response = await fixture.service.apply(ctx, first);
        expect(await fixture.service.apply(ctx, first)).toEqual(response);
        expect((await fixture.service.status(ctx)).version).toBe(1);
        await fixture.apply({
            action: "set_capability",
            capability: "group_chats",
            consent: "granted",
        });
        expect((await fixture.service.apply(ctx, first)).status).toMatchObject({
            capabilities: { group_chats: { consent: "granted" } },
            version: 2,
        });
        expect(await fixture.service.status(ctx)).toMatchObject({
            capabilities: { group_chats: { consent: "granted" } },
            version: 2,
        });
        await fixture.store.close(ctx);
        const restartedStore = await PersistentSessionStore.open(ctx, {
            databasePath: fixture.path,
        });
        const restarted = restartedStore.happyCloud;
        expect((await restarted.apply(ctx, first)).status).toMatchObject({
            capabilities: { group_chats: { consent: "granted" } },
            version: 2,
        });
        await expect(
            restarted.apply(ctx, {
                ...first,
                action: "set_enrollment",
                state: "not_enrolled",
            }),
        ).rejects.toThrow("already used");

        const stale = await fixture.command(
            {
                action: "set_capability",
                capability: "remote_control",
                consent: "granted",
            },
            0,
        );
        await expect(restarted.apply(ctx, stale)).rejects.toThrow(
            "changed before this command arrived",
        );
        expect((await restarted.status(ctx)).capabilities.remote_control.consent).toBe("denied");
        await restartedStore.close(ctx);
    });

    it("shares the store transaction and never survives its database owner", async () => {
        const fixture = await createFixture();
        const events: string[] = [];
        const unsubscribe = fixture.store.liveEvents.subscribe(({ event }) => {
            if (event.type === "happy_cloud_changed") events.push(event.id);
        });
        const enrollment = await fixture.command({
            action: "set_enrollment",
            state: "enrolled",
        });
        await expect(
            fixture.store.transaction(ctx, async (txCtx) => {
                await fixture.service.apply(txCtx, enrollment);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect((await fixture.service.status(ctx)).version).toBe(0);
        expect(events).toEqual([]);
        unsubscribe();

        await fixture.store.close(ctx);
        await expect(fixture.service.status(ctx)).rejects.toThrow("session database is closed");
    });

    it("publishes one lightweight event after commit and none for duplicate or rejected commands", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const deliveredEvents: Parameters<typeof isLiveGlobalEvent>[0][] = [];
        const observed: Array<{ mutationId: string; observedVersion: number; version: number }> =
            [];
        const unsubscribe = fixture.store.liveEvents.subscribe(({ event }) => {
            if (event.type !== "happy_cloud_changed") return;
            deliveredEvents.push(event);
            void fixture.service.status(ctx).then((status) => {
                observed.push({
                    mutationId: event.data.mutationId,
                    observedVersion: status.version,
                    version: event.data.version,
                });
            });
        });
        const enrollment = await fixture.command({
            action: "set_enrollment",
            state: "enrolled",
        });
        await fixture.service.apply(ctx, enrollment);
        await fixture.service.apply(ctx, enrollment);
        await expect(
            fixture.service.apply(
                ctx,
                await fixture.command(
                    {
                        action: "set_capability",
                        capability: "group_chats",
                        consent: "granted",
                    },
                    0,
                ),
            ),
        ).rejects.toThrow("changed before this command arrived");
        await vi.waitFor(() => expect(observed).toHaveLength(1));
        expect(observed).toEqual([
            {
                mutationId: enrollment.mutationId,
                observedVersion: 1,
                version: 1,
            },
        ]);
        expect(deliveredEvents.every(isLiveGlobalEvent)).toBe(true);
        expect(
            (await fixture.store.globalEventQueue.list(ctx))?.some(
                (entry) => entry.event.type === "happy_cloud_changed",
            ),
        ).toBe(false);
        unsubscribe();
        await fixture.store.close(ctx);
    });

    it("retains only the documented newest 4,096 successful mutation receipts", async () => {
        const fixture = await createFixture();
        await fixture.store.close(ctx);
        const database = createClient({ url: pathToFileURL(fixture.path).href });
        const transaction = await database.transaction("write");
        try {
            for (let index = 0; index < 4_096; index += 1) {
                await transaction.execute({
                    args: [
                        `fixture-${String(index)}`,
                        index.toString(16).padStart(64, "0"),
                        "{}",
                        index,
                    ],
                    sql: `INSERT INTO happy_cloud_mutation_receipts
                        (mutation_id, request_fingerprint, response_json, created_at_ms)
                     VALUES (?, ?, ?, ?)`,
                });
            }
            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            throw error;
        } finally {
            await transaction.close();
            await database.close();
        }

        const restarted = await PersistentSessionStore.open(ctx, {
            databasePath: fixture.path,
        });
        await restarted.happyCloud.apply(ctx, {
            action: "set_enrollment",
            contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
            expectedVersion: 0,
            mutationId: "newest-receipt",
            state: "enrolled",
        });
        await restarted.close(ctx);

        const inspected = createClient({ url: pathToFileURL(fixture.path).href });
        const count = (
            await inspected.execute("SELECT COUNT(*) AS count FROM happy_cloud_mutation_receipts")
        ).rows[0] as unknown as { count: number };
        expect(count.count).toBe(4_096);
        expect(
            (
                await inspected.execute({
                    args: ["fixture-0"],
                    sql: "SELECT mutation_id FROM happy_cloud_mutation_receipts WHERE mutation_id = ?",
                })
            ).rows[0],
        ).toBeUndefined();
        expect(
            (
                await inspected.execute({
                    args: ["newest-receipt"],
                    sql: "SELECT mutation_id FROM happy_cloud_mutation_receipts WHERE mutation_id = ?",
                })
            ).rows[0],
        ).toBeDefined();
        await inspected.close();
    });

    it("evicts the oldest encrypted session blob at the global retention limit", async () => {
        const fixture = await createFixture();
        await fixture.apply({ action: "set_enrollment", state: "enrolled" });
        await fixture.apply({
            action: "set_capability",
            capability: "session_blob_persistence",
            consent: "granted",
        });
        for (let index = 0; index <= HAPPY_CLOUD_SESSION_BLOB_LIMIT; index += 1) {
            await fixture.apply({
                action: "put_session_blob",
                ciphertext: Buffer.from(`blob_${String(index)}`).toString("base64url"),
                sessionId: `mobile-${String(index).padStart(3, "0")}`,
            });
        }
        expect(await fixture.service.getSessionBlob(ctx, "mobile-000")).toBeUndefined();
        expect(
            await fixture.service.getSessionBlob(
                ctx,
                `mobile-${String(HAPPY_CLOUD_SESSION_BLOB_LIMIT).padStart(3, "0")}`,
            ),
        ).toBeDefined();
        await fixture.store.close(ctx);
    });
});

async function createFixture(options: { durableGlobalEventQueue?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-cloud-"));
    directories.push(directory);
    const path = join(directory, "sessions.sqlite");
    let now = 1_000;
    let mutation = 0;
    const store = await PersistentSessionStore.open(ctx, {
        databasePath: path,
        ...(options.durableGlobalEventQueue === undefined
            ? {}
            : { durableGlobalEventQueue: options.durableGlobalEventQueue }),
        now: () => ++now,
    });
    const service = store.happyCloud;
    const command = async <T extends CommandInput>(
        input: T,
        expectedVersion?: number,
    ): Promise<HappyCloudCommand> =>
        ({
            ...input,
            contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
            expectedVersion: expectedVersion ?? (await service.status(ctx)).version,
            mutationId: `mutation-${String(++mutation)}`,
        }) as HappyCloudCommand;
    return {
        apply: async (input: CommandInput) => service.apply(ctx, await command(input)),
        command,
        path,
        service,
        store,
    };
}

type CommandInput = OmitDistributive<
    HappyCloudCommand,
    "contractVersion" | "expectedVersion" | "mutationId"
>;
type OmitDistributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
