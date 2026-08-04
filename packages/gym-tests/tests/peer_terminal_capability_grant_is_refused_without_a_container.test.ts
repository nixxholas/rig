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
 * Drives session sharing and peer capabilities the way Happy or another client
 * would: over the daemon's local socket with its bearer token, never through
 * Rig internals. Mirrors the harness in
 * `session_sharing_is_reachable_and_replicates_the_transcript.test.ts`.
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

/** Poll one daemon route until it answers the way the scenario needs. */
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

describe("peer terminal_view capability requires a container environment", () => {
    it("refuses to grant terminal_view on a host project, explains why in readable English, and leaves the friend at the default of reading only", async () => {
        const relay = await MurmurRelayServer.start();
        relays.add(relay);

        const [owner, friend] = await Promise.all([
            createGym({
                inference: [{ content: [{ text: "Ready to share.", type: "text" }] }],
            }),
            createGym({ inference: [{ content: [{ text: "Standing by.", type: "text" }] }] }),
        ]);
        running.add(owner);
        running.add(friend);
        await askOnce(owner, "Get ready.", "Ready to share.");
        await askOnce(friend, "Wait for a share.", "Standing by.");

        await joinMurmur(owner, relay.url, "Robin");
        const friendAccount = await joinMurmur(friend, relay.url, "Dana");

        // Real Murmur friendship, exactly the way two people would become friends,
        // so the share invites an authenticated peer rather than a fixture.
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

        const created = await waitFor(
            owner,
            "POST",
            "/sessions/{session}/share",
            (response) => response.status === 201,
            "the owner to invite the friend into a shared session",
            {
                friends: [{ displayName: "Dana", peerId: friendAccount.peerId }],
                includeFriendMessagesInModel: false,
                mutationId: "mutation-share-1",
            },
        );
        const shareId = (created.body.share as { shareId: string }).shareId;
        const shareMemberId = (created.body.members as { shareMemberId: string }[])[0]!
            .shareMemberId;

        // This is a host project: no `--docker-image` was passed to either Gym, so
        // there is no container execution environment. The offerable-capability list
        // already tells the owner why before they try to grant anything.
        const offerable = (
            created.body.share as {
                offerableCapabilities: {
                    capability: string;
                    offerable: boolean;
                    unavailableReason?: string;
                }[];
            }
        ).offerableCapabilities;
        expect(offerable).toMatchObject([
            {
                capability: "terminal_view",
                offerable: false,
                unavailableReason: expect.stringContaining("container environment"),
            },
        ]);
        expect(offerable[0]?.unavailableReason).toContain(
            "A terminal on your own machine can read your credentials",
        );

        // Granting it anyway is refused with that same sentence, not stored and then
        // quietly unusable.
        const granted = await callDaemon(
            owner,
            "PUT",
            `/sessions/{session}/share/members/${shareMemberId}/capabilities`,
            { capabilities: ["terminal_view"], mutationId: "mutation-grant-1" },
        );
        // A deliberate, permanent refusal is a 4xx a client must not retry, not a 500.
        expect(granted.status).toBe(422);
        expect(String(granted.body.error)).toContain("container environment");
        expect(String(granted.body.error)).toContain("read your credentials");

        // The capability route itself is otherwise healthy: granting the only set
        // this host project can ever offer -- nothing -- still succeeds.
        const grantedEmpty = await callDaemon(
            owner,
            "PUT",
            `/sessions/{session}/share/members/${shareMemberId}/capabilities`,
            { capabilities: [], mutationId: "mutation-grant-2" },
        );
        expect(grantedEmpty.status).toBe(200);
        const ownerMember = (
            grantedEmpty.body.members as {
                capabilities: string[];
                capabilitiesDescription: string;
            }[]
        )[0]!;
        expect(ownerMember.capabilities).toEqual([]);
        expect(ownerMember.capabilitiesDescription).toBe("Read the conversation only");

        // Default is nothing, confirmed independently on the friend's own daemon.
        const friendCapabilities = await waitFor(
            friend,
            "GET",
            `/session-share-replicas/${shareId}/capabilities`,
            (response) => response.status === 200,
            "the friend's replica to report its own capabilities",
        );
        expect(friendCapabilities.body).toMatchObject({
            capabilities: [],
            description: "Read the conversation only",
            shareId,
        });

        // The peer-activity route is reachable, and since nothing was ever authorized
        // to attach, it has nothing to report yet.
        const activity = await callDaemon(owner, "GET", "/sessions/{session}/share/peer-activity");
        expect(activity.status).toBe(200);
        expect(activity.body).toMatchObject({ complete: true, entries: [] });

        // The terminal stays healthy and usable throughout.
        const [ownerScreen, friendScreen] = await Promise.all([
            owner.terminal.snapshot(),
            friend.terminal.snapshot(),
        ]);
        expect(ownerScreen.text).toContain("Ask Rig to do anything");
        expect(friendScreen.text).toContain("Ask Rig to do anything");
    }, 300_000);
});
