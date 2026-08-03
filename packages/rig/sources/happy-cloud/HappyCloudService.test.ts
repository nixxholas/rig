import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
    HAPPY_CLOUD_CONTRACT_VERSION,
    isLiveGlobalEvent,
    type HappyCloudCommand,
} from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { HAPPY_CLOUD_SESSION_BLOB_LIMIT } from "../persistence/happy-cloud/happyCloudApplyCommand.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("HappyCloudService", () => {
    it("starts denied, keeps enrollment separate, and persists independent choices across restart", async () => {
        const fixture = await createFixture();
        expect(fixture.service.status()).toMatchObject({
            capabilities: {
                friends: { consent: "denied" },
                group_chats: { consent: "denied" },
                happy_profile: { consent: "denied" },
                live_session_sharing: { consent: "denied" },
                remote_control: { consent: "denied" },
                session_blob_persistence: { consent: "denied" },
            },
            contractVersion: 1,
            enrollment: { state: "not_enrolled" },
            version: 0,
        });

        fixture.apply({ action: "set_enrollment", state: "enrolled" });
        fixture.apply({
            action: "set_capability",
            capability: "friends",
            consent: "granted",
        });
        fixture.apply({
            action: "set_capability",
            capability: "remote_control",
            consent: "granted",
        });
        fixture.store.close();

        const restarted = new PersistentSessionStore({ databasePath: fixture.path });
        expect(restarted.happyCloud.status()).toMatchObject({
            capabilities: {
                friends: { consent: "granted" },
                group_chats: { consent: "denied" },
                remote_control: { consent: "granted" },
            },
            enrollment: { state: "enrolled" },
            version: 3,
        });
        restarted.close();
    });

    it("rejects capability and ciphertext changes before their explicit gates are granted", async () => {
        const fixture = await createFixture();
        expect(() =>
            fixture.apply({
                action: "set_capability",
                capability: "friends",
                consent: "granted",
            }),
        ).toThrow("Enroll in Happy Cloud");
        expect(fixture.service.status().version).toBe(0);
        fixture.apply({ action: "set_enrollment", state: "enrolled" });
        expect(() => fixture.apply({ action: "put_profile", ciphertext: "b3BhcXVl" })).toThrow(
            "Grant the happy profile capability",
        );
        expect(() =>
            fixture.apply({
                action: "put_session_blob",
                ciphertext: "b3BhcXVl",
                sessionId: "session-1",
            }),
        ).toThrow("Grant the session blob persistence capability");
        fixture.store.close();
    });

    it("stores ciphertext verbatim and revocation removes only the affected encrypted data", async () => {
        const fixture = await createFixture();
        fixture.apply({ action: "set_enrollment", state: "enrolled" });
        fixture.apply({
            action: "set_capability",
            capability: "happy_profile",
            consent: "granted",
        });
        fixture.apply({
            action: "set_capability",
            capability: "session_blob_persistence",
            consent: "granted",
        });
        const profile = "cHJvZmlsZV9jaXBoZXJ0ZXh0";
        const blob = "c2Vzc2lvbl9jaXBoZXJ0ZXh0";
        fixture.apply({ action: "put_profile", ciphertext: profile });
        fixture.apply({
            action: "put_session_blob",
            ciphertext: blob,
            sessionId: "mobile/session",
        });
        expect(fixture.service.getProfile()).toEqual({ ciphertext: profile, version: 4 });
        expect(fixture.service.getSessionBlob("mobile/session")?.ciphertext).toBe(blob);

        fixture.apply({
            action: "set_capability",
            capability: "friends",
            consent: "granted",
        });
        expect(fixture.service.getProfile()).toEqual({ ciphertext: profile, version: 4 });

        fixture.apply({
            action: "set_capability",
            capability: "happy_profile",
            consent: "denied",
        });
        expect(fixture.service.getProfile()).toBeUndefined();
        expect(fixture.service.getSessionBlob("mobile/session")?.ciphertext).toBe(blob);

        fixture.apply({ action: "set_enrollment", state: "not_enrolled" });
        expect(fixture.service.status().capabilities.session_blob_persistence.consent).toBe(
            "denied",
        );
        expect(fixture.service.getSessionBlob("mobile/session")).toBeUndefined();
        fixture.store.close();

        const database = new DatabaseSync(fixture.path);
        const receipts = database
            .prepare("SELECT request_fingerprint, response_json FROM happy_cloud_mutation_receipts")
            .all() as Array<{ request_fingerprint: string; response_json: string }>;
        expect(
            receipts.every((receipt) => /^[a-f0-9]{64}$/u.test(receipt.request_fingerprint)),
        ).toBe(true);
        expect(receipts.some((receipt) => receipt.response_json.includes(profile))).toBe(false);
        expect(receipts.some((receipt) => receipt.response_json.includes(blob))).toBe(false);
        database.close();
    });

    it("is idempotent for exact duplicate mutations and rejects reuse or stale reordered commands", async () => {
        const fixture = await createFixture();
        const first = fixture.command({
            action: "set_enrollment",
            state: "enrolled",
        });
        const response = fixture.service.apply(first);
        expect(fixture.service.apply(first)).toEqual(response);
        expect(fixture.service.status().version).toBe(1);
        fixture.apply({
            action: "set_capability",
            capability: "friends",
            consent: "granted",
        });
        expect(fixture.service.apply(first).status).toMatchObject({
            capabilities: { friends: { consent: "granted" } },
            version: 2,
        });
        expect(fixture.service.status()).toMatchObject({
            capabilities: { friends: { consent: "granted" } },
            version: 2,
        });
        fixture.store.close();
        const restartedStore = new PersistentSessionStore({ databasePath: fixture.path });
        const restarted = restartedStore.happyCloud;
        expect(restarted.apply(first).status).toMatchObject({
            capabilities: { friends: { consent: "granted" } },
            version: 2,
        });
        expect(() =>
            restarted.apply({
                ...first,
                action: "set_enrollment",
                state: "not_enrolled",
            }),
        ).toThrow("already used");

        const stale = fixture.command(
            {
                action: "set_capability",
                capability: "remote_control",
                consent: "granted",
            },
            0,
        );
        expect(() => restarted.apply(stale)).toThrow("changed before this command arrived");
        expect(restarted.status().capabilities.remote_control.consent).toBe("denied");
        restartedStore.close();
    });

    it("shares the store transaction and never survives its database owner", async () => {
        const fixture = await createFixture();
        const events: string[] = [];
        const unsubscribe = fixture.store.liveEvents.subscribe(({ event }) => {
            if (event.type === "happy_cloud_changed") events.push(event.id);
        });
        const enrollment = fixture.command({
            action: "set_enrollment",
            state: "enrolled",
        });
        expect(() =>
            fixture.store.transaction(() => {
                fixture.service.apply(enrollment);
                throw new Error("rollback");
            }),
        ).toThrow("rollback");
        expect(fixture.service.status().version).toBe(0);
        expect(events).toEqual([]);
        unsubscribe();

        fixture.store.close();
        expect(() => fixture.service.status()).toThrow("session database is closed");
    });

    it("publishes one lightweight event after commit and none for duplicate or rejected commands", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const deliveredEvents: Parameters<typeof isLiveGlobalEvent>[0][] = [];
        const observed: Array<{ mutationId: string; observedVersion: number; version: number }> =
            [];
        const unsubscribe = fixture.store.liveEvents.subscribe(({ event }) => {
            if (event.type !== "happy_cloud_changed") return;
            deliveredEvents.push(event);
            observed.push({
                mutationId: event.data.mutationId,
                observedVersion: fixture.service.status().version,
                version: event.data.version,
            });
        });
        const enrollment = fixture.command({
            action: "set_enrollment",
            state: "enrolled",
        });
        fixture.service.apply(enrollment);
        fixture.service.apply(enrollment);
        expect(() =>
            fixture.service.apply(
                fixture.command(
                    {
                        action: "set_capability",
                        capability: "friends",
                        consent: "granted",
                    },
                    0,
                ),
            ),
        ).toThrow("changed before this command arrived");
        expect(observed).toEqual([
            {
                mutationId: enrollment.mutationId,
                observedVersion: 1,
                version: 1,
            },
        ]);
        expect(deliveredEvents.every(isLiveGlobalEvent)).toBe(true);
        expect(
            fixture.store.globalEventQueue
                .list()
                ?.some((entry) => entry.event.type === "happy_cloud_changed"),
        ).toBe(false);
        unsubscribe();
        fixture.store.close();
    });

    it("retains only the documented newest 4,096 successful mutation receipts", async () => {
        const fixture = await createFixture();
        fixture.store.close();
        const database = new DatabaseSync(fixture.path);
        const insert = database.prepare(
            `INSERT INTO happy_cloud_mutation_receipts
                (mutation_id, request_fingerprint, response_json, created_at_ms)
             VALUES (?, ?, ?, ?)`,
        );
        database.exec("BEGIN");
        for (let index = 0; index < 4_096; index += 1) {
            insert.run(
                `fixture-${String(index)}`,
                index.toString(16).padStart(64, "0"),
                "{}",
                index,
            );
        }
        database.exec("COMMIT");
        database.close();

        const restarted = new PersistentSessionStore({ databasePath: fixture.path });
        restarted.happyCloud.apply({
            action: "set_enrollment",
            contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
            expectedVersion: 0,
            mutationId: "newest-receipt",
            state: "enrolled",
        });
        restarted.close();

        const inspected = new DatabaseSync(fixture.path);
        const count = inspected
            .prepare("SELECT COUNT(*) AS count FROM happy_cloud_mutation_receipts")
            .get() as { count: number };
        expect(count.count).toBe(4_096);
        expect(
            inspected
                .prepare(
                    "SELECT mutation_id FROM happy_cloud_mutation_receipts WHERE mutation_id = ?",
                )
                .get("fixture-0"),
        ).toBeUndefined();
        expect(
            inspected
                .prepare(
                    "SELECT mutation_id FROM happy_cloud_mutation_receipts WHERE mutation_id = ?",
                )
                .get("newest-receipt"),
        ).toBeDefined();
        inspected.close();
    });

    it("evicts the oldest encrypted session blob at the global retention limit", async () => {
        const fixture = await createFixture();
        fixture.apply({ action: "set_enrollment", state: "enrolled" });
        fixture.apply({
            action: "set_capability",
            capability: "session_blob_persistence",
            consent: "granted",
        });
        for (let index = 0; index <= HAPPY_CLOUD_SESSION_BLOB_LIMIT; index += 1) {
            fixture.apply({
                action: "put_session_blob",
                ciphertext: Buffer.from(`blob_${String(index)}`).toString("base64url"),
                sessionId: `mobile-${String(index).padStart(3, "0")}`,
            });
        }
        expect(fixture.service.getSessionBlob("mobile-000")).toBeUndefined();
        expect(
            fixture.service.getSessionBlob(
                `mobile-${String(HAPPY_CLOUD_SESSION_BLOB_LIMIT).padStart(3, "0")}`,
            ),
        ).toBeDefined();
        fixture.store.close();
    });
});

async function createFixture(options: { durableGlobalEventQueue?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-cloud-"));
    directories.push(directory);
    const path = join(directory, "sessions.sqlite");
    let now = 1_000;
    let mutation = 0;
    const store = new PersistentSessionStore({
        databasePath: path,
        ...(options.durableGlobalEventQueue === undefined
            ? {}
            : { durableGlobalEventQueue: options.durableGlobalEventQueue }),
        now: () => ++now,
    });
    const service = store.happyCloud;
    const command = <T extends CommandInput>(
        input: T,
        expectedVersion = service.status().version,
    ): HappyCloudCommand =>
        ({
            ...input,
            contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
            expectedVersion,
            mutationId: `mutation-${String(++mutation)}`,
        }) as HappyCloudCommand;
    return {
        apply: (input: CommandInput) => service.apply(command(input)),
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
