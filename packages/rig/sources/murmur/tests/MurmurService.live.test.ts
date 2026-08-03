import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { SqliteMurmurStore } from "../../persistence/murmur/index.js";
import { DEFAULT_MURMUR_RELAY_URLS, MurmurService } from "../index.js";

const describeLive = process.env.RIG_LIVE_TEST === "1" ? describe : describe.skip;

describeLive("Murmur service against the hosted relay", () => {
    it("exchanges and explicitly accepts a friend request through the default relay", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-murmur-live-"));
        const alicePath = join(directory, "alice.sqlite");
        const bobPath = join(directory, "bob.sqlite");
        const alice = new MurmurService({
            storeFactory: () => new SqliteMurmurStore(alicePath),
            syncWaitMilliseconds: 1_000,
        });
        const bob = new MurmurService({
            storeFactory: () => new SqliteMurmurStore(bobPath),
            syncWaitMilliseconds: 1_000,
        });
        try {
            const photo = await createHighEntropyPhoto();
            const aliceAccount = (
                await alice.signup({
                    firstName: "Rig",
                    lastName: "Alice",
                    photo: { data: photo.toString("base64"), mediaType: "image/png" },
                })
            ).account;
            const bobAccount = (await bob.signup({ firstName: "Rig", lastName: "Bob" })).account;
            expect(aliceAccount.profile.photo).toMatchObject({
                mediaType: "image/webp",
            });
            expect(aliceAccount.profile.photo!.bytes).toBeLessThanOrEqual(96 * 1024);

            await expect(alice.start()).resolves.toEqual({
                service: { relayUrls: [...DEFAULT_MURMUR_RELAY_URLS], status: "running" },
            });
            await expect(bob.start()).resolves.toEqual({
                service: { relayUrls: [...DEFAULT_MURMUR_RELAY_URLS], status: "running" },
            });
            await expect(alice.sendFriendRequest({ token: bobAccount.token })).resolves.toEqual({
                recipientId: bobAccount.id,
            });

            const request = await waitForFriendRequest(bob, aliceAccount.id);
            await expect(
                bob.answerFriendRequest(request.id, { answer: "accept" }),
            ).resolves.toMatchObject({
                answer: "accept",
                contact: {
                    id: aliceAccount.id,
                    profile: {
                        firstName: "Rig",
                        lastName: "Alice",
                        photo: { thumbhash: aliceAccount.profile.photo!.thumbhash },
                    },
                },
            });
            await expect(bob.listContacts()).resolves.toMatchObject({
                contacts: [{ id: aliceAccount.id }],
            });
        } finally {
            await Promise.allSettled([alice.deleteAccount(), bob.deleteAccount()]);
            await Promise.allSettled([alice.close(), bob.close()]);
            await rm(directory, { force: true, recursive: true });
        }
    }, 30_000);
});

async function createHighEntropyPhoto(): Promise<Buffer> {
    const pixels = Buffer.alloc(512 * 512 * 4);
    let state = 0x1234_5678;
    for (let index = 0; index < pixels.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        pixels[index] = state >>> 24;
    }
    return sharp(pixels, {
        raw: { channels: 4, height: 512, width: 512 },
    })
        .png()
        .toBuffer();
}

async function waitForFriendRequest(service: MurmurService, senderId: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const request = (await service.listFriendRequests()).requests.find(
            (candidate) => candidate.senderId === senderId,
        );
        if (request !== undefined) return request;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the hosted Murmur relay to deliver the friend request.");
}
