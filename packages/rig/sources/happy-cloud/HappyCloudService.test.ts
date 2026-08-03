import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HAPPY_CLOUD_CONTRACT_VERSION, type HappyCloudCommand } from "../protocol/index.js";
import { HappyCloudService } from "./HappyCloudService.js";

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
        fixture.service.close();

        const restarted = new HappyCloudService(fixture.path);
        expect(restarted.status()).toMatchObject({
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
        expect(() => fixture.apply({ action: "put_profile", ciphertext: "opaque" })).toThrow(
            "Grant the happy profile capability",
        );
        expect(() =>
            fixture.apply({
                action: "put_session_blob",
                ciphertext: "opaque",
                sessionId: "session-1",
            }),
        ).toThrow("Grant the session blob persistence capability");
        fixture.service.close();
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
        const profile = "\u0000ciphertext:profile/+/=";
        const blob = "ciphertext:session\nverbatim";
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
        fixture.service.close();
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
        fixture.service.close();
        const restarted = new HappyCloudService(fixture.path);
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
        restarted.close();
    });
});

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), "rig-happy-cloud-"));
    directories.push(directory);
    const path = join(directory, "sessions.sqlite");
    let now = 1_000;
    let mutation = 0;
    const service = new HappyCloudService(path, () => ++now);
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
    };
}

type CommandInput = OmitDistributive<
    HappyCloudCommand,
    "contractVersion" | "expectedVersion" | "mutationId"
>;
type OmitDistributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
