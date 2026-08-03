import { afterEach, describe, expect, it } from "vitest";

import { createGym, MurmurRelayServer, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const relays = new Set<MurmurRelayServer>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
    await Promise.all([...relays].map((relay) => relay.close()));
    relays.clear();
});

/**
 * Drives session sharing the way Happy or another client would: over the
 * daemon's local socket with its bearer token, never through Rig internals.
 */
const CLIENT_SCRIPT = `
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");

const directory = process.env.RIG_SERVER_DIRECTORY;
const token = readFileSync(join(directory, "token"), "utf8").trim();
const socketPath = join(directory, "server.sock");

function call(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { authorization: "Bearer " + token };
        if (payload !== undefined) {
            headers["content-type"] = "application/json";
            headers["content-length"] = Buffer.byteLength(payload);
        }
        const outgoing = request({ headers, method, path, socketPath }, (response) => {
            let data = "";
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => {
                resolve({
                    body: data.length === 0 ? {} : JSON.parse(data),
                    status: response.statusCode,
                });
            });
        });
        outgoing.on("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}

(async () => {
    const [method, rawPath, rawBody] = process.argv.slice(1);
    const listed = await call("GET", "/sessions");
    const sessionId = listed.body.sessions[0].id;
    const path = rawPath.replace("{session}", sessionId);
    const body = rawBody === undefined || rawBody === "" ? undefined : JSON.parse(rawBody);
    process.stdout.write(JSON.stringify(await call(method, path, body)));
})().catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(1);
});
`;

interface ProtocolResponse {
    readonly body: Record<string, unknown>;
    readonly status: number;
}

async function callDaemon(
    gym: Gym,
    method: string,
    path: string,
    body?: unknown,
): Promise<ProtocolResponse> {
    const { stdout } = await gym.runInContainer("node", [
        "-e",
        CLIENT_SCRIPT,
        method,
        path,
        body === undefined ? "" : JSON.stringify(body),
    ]);
    return JSON.parse(stdout) as ProtocolResponse;
}

/** Sign one Gym up for Murmur and point its service at the test's own relay. */
async function joinMurmur(
    gym: Gym,
    relayUrl: string,
    firstName: string,
): Promise<{ peerId: string; token: string }> {
    const signup = await callDaemon(gym, "POST", "/murmur/account", {
        firstName,
        lastName: "Gym",
    });
    expect(signup.status).toBe(201);
    const started = await callDaemon(gym, "POST", "/murmur/service/start", {
        relayUrls: [relayUrl],
    });
    expect(started.status).toBe(200);
    const account = signup.body.account as { id: string; token: string };
    return { peerId: account.id, token: account.token };
}

/**
 * Poll one daemon route until it answers the way the scenario needs.
 *
 * Murmur replication is relay-driven, so the moment a friendship or a
 * replicated transcript lands is a state to wait for, never a fixed delay.
 */
async function waitFor(
    gym: Gym,
    method: string,
    path: string,
    accept: (response: ProtocolResponse) => boolean,
    description: string,
    body?: unknown,
): Promise<ProtocolResponse> {
    const deadline = Date.now() + 120_000;
    let last: ProtocolResponse | undefined;
    while (Date.now() < deadline) {
        last = await callDaemon(gym, method, path, body);
        if (accept(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${description}; last saw ${JSON.stringify(last)}`);
}

async function askOnce(gym: Gym, prompt: string, reply: string): Promise<void> {
    gym.terminal.type(prompt);
    gym.terminal.press("enter");
    await gym.terminal.waitForText(reply, 30_000);
}

describe("session sharing is reachable from a real daemon", () => {
    it("serves the share routes and explains what a share still needs", async () => {
        const gym = await createGym({
            files: { "notes.md": "shared session notes\n" },
            inference: [{ content: [{ text: "Reviewed the notes.", type: "text" }] }],
        });
        running.add(gym);
        await askOnce(gym, "Look at the notes.", "Reviewed the notes.");

        // Sharing is wired into the daemon, so the route answers instead of reporting
        // that this server was started without session sharing.
        const before = await callDaemon(gym, "GET", "/sessions/{session}/share");
        expect(before.status).toBe(404);
        expect(JSON.stringify(before.body)).not.toContain("without session sharing");

        // Without a Murmur account there is nobody to own a share, and the daemon says
        // exactly that rather than failing anonymously.
        const unowned = await callDaemon(gym, "POST", "/sessions/{session}/share", {
            friends: [{ displayName: "Dana", peerId: "not-a-peer" }],
            includeFriendMessagesInModel: true,
            mutationId: "mutation-1",
        });
        expect(unowned.status).toBe(500);
        expect(String(unowned.body.error)).toContain("Set up a Murmur account");

        expect(await callDaemon(gym, "GET", "/session-share-replicas")).toMatchObject({
            body: { replicas: [] },
            status: 200,
        });

        // The terminal stays healthy and usable while the share routes are exercised.
        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Ask Rig to do anything");
        expect(screen.text).not.toContain("\uFFFD");
    }, 120_000);

    it("replicates an owner's transcript to a friend's daemon over a real relay", async () => {
        const relay = await MurmurRelayServer.start();
        relays.add(relay);

        const [owner, friend] = await Promise.all([
            createGym({
                files: { "notes.md": "shared session notes\n" },
                inference: [{ content: [{ text: "Reviewed the notes.", type: "text" }] }],
            }),
            createGym({ inference: [{ content: [{ text: "Standing by.", type: "text" }] }] }),
        ]);
        running.add(owner);
        running.add(friend);
        await askOnce(owner, "Look at the notes.", "Reviewed the notes.");
        await askOnce(friend, "Wait for a share.", "Standing by.");

        const ownerAccount = await joinMurmur(owner, relay.url, "Robin");
        const friendAccount = await joinMurmur(friend, relay.url, "Dana");

        // Become Murmur friends the way two people would, so the share invites a real
        // authenticated peer rather than a fixture.
        const sent = await callDaemon(owner, "POST", "/murmur/friend-requests", {
            token: friendAccount.token,
        });
        expect(sent.status).toBe(202);
        const incoming = await waitFor(
            friend,
            "GET",
            "/murmur/friend-requests",
            (response) => (response.body.requests as unknown[] | undefined)?.length === 1,
            "the owner's friend request to reach the friend",
        );
        const senderId = (incoming.body.requests as { senderId: string }[])[0]!.senderId;
        const answered = await callDaemon(
            friend,
            "POST",
            `/murmur/friend-requests/${senderId}/answer`,
            { answer: "accept" },
        );
        expect(answered.status).toBe(200);
        await waitFor(
            owner,
            "GET",
            "/murmur/friends",
            (response) =>
                (response.body.friendships as { peerId: string; state: string }[]).some(
                    (friendship) =>
                        friendship.peerId === friendAccount.peerId &&
                        friendship.state === "friends",
                ),
            "the friendship to be confirmed on the owner",
        );

        // The friend offers a key package as soon as it sees the friendship, and the
        // owner asks for one if it arrives first, so the invitation completes on retry.
        const created = await waitFor(
            owner,
            "POST",
            "/sessions/{session}/share",
            (response) => response.status === 201,
            "the owner to invite the friend into a shared session",
            {
                // Deliberately not the friend's Murmur profile name: a friend's messages
                // are rendered under the name the owner registered, not one off the network.
                friends: [{ displayName: "Dana from Ops", peerId: friendAccount.peerId }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            },
        );
        expect(created.body).toMatchObject({
            members: [expect.objectContaining({ displayName: "Dana from Ops", state: "active" })],
            share: expect.objectContaining({ includeFriendMessagesInModel: true, memberCount: 1 }),
        });
        const shareId = (created.body.share as { shareId: string }).shareId;

        const replicas = await waitFor(
            friend,
            "GET",
            "/session-share-replicas",
            (response) =>
                (response.body.replicas as { grant: { shareId: string } }[]).some(
                    (replica) => replica.grant.shareId === shareId,
                ),
            "the shared session to appear on the friend's daemon",
        );
        expect(replicas.body.replicas).toMatchObject([
            expect.objectContaining({ ownerPeerId: ownerAccount.peerId, state: "active" }),
        ]);

        const history = await waitFor(
            friend,
            "GET",
            `/session-share-replicas/${shareId}/history`,
            (response) => ((response.body.entries as unknown[] | undefined) ?? []).length > 0,
            "the owner's transcript to replicate to the friend",
        );
        const entries = history.body.entries as { canonicalJson: string; shareSequence: number }[];
        expect(entries.map((entry) => entry.shareSequence)).toEqual(
            entries.map((_, index) => index + 1),
        );
        expect(entries.map((entry) => entry.canonicalJson).join("\n")).toContain(
            "Look at the notes.",
        );

        // The friend answers, and the owner accepts the post under the name it registered.
        const grant = (replicas.body.replicas as { grant: unknown }[])[0]!.grant;
        const posted = await callDaemon(friend, "POST", "/session-shares/friend-messages", {
            clientMessageId: "friend-message-1",
            grant,
            text: "Please double-check the second paragraph.",
        });
        expect(posted).toMatchObject({
            body: { accepted: true, clientMessageId: "friend-message-1" },
            status: 202,
        });
        const events = await waitFor(
            owner,
            "GET",
            "/sessions/{session}/events",
            (response) => JSON.stringify(response.body).includes("second paragraph"),
            "the friend's message to reach the owner's session",
        );
        const serialized = JSON.stringify(events.body);
        expect(serialized).toContain("Dana from Ops");
        expect(serialized).not.toContain("Dana Gym");

        // Stopping the share is authoritative: the friend's replica ends on its own.
        const stopped = await callDaemon(owner, "POST", "/sessions/{session}/share/stop", {
            mutationId: "mutation-2",
        });
        expect(stopped.status).toBe(200);
        await waitFor(
            friend,
            "GET",
            "/session-share-replicas",
            (response) =>
                (response.body.replicas as { state: string }[]).every(
                    (replica) => replica.state === "ended",
                ),
            "the friend's replica to end with the share",
        );
    }, 300_000);
});
