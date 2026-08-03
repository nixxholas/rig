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
 * Drives project sharing the way Happy or another client would: over the daemon's
 * local socket with its bearer token, never through Rig internals.
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
    const session = listed.body.sessions[0];
    const path = rawPath
        .replace("{session}", session.id)
        .replace("{project}", session.projectId);
    const body = rawBody === undefined || rawBody === "" ? undefined : JSON.parse(rawBody);
    process.stdout.write(JSON.stringify({
        ...(await call(method, path, body)),
        projectId: session.projectId,
        sessionId: session.id,
    }));
})().catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(1);
});
`;

interface ProtocolResponse {
    readonly body: Record<string, unknown>;
    /** The project and session the call was addressed to, resolved inside the daemon. */
    readonly projectId: string;
    readonly sessionId: string;
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
 * Murmur replication is relay-driven, so the moment a friendship or a replicated
 * scope lands is a state to wait for, never a fixed delay.
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

describe("project sharing is reachable from a real daemon", () => {
    it("serves the project share routes instead of reporting sharing was left out", async () => {
        const gym = await createGym({
            files: { "notes.md": "shared project notes\n" },
            inference: [{ content: [{ text: "Reviewed the notes.", type: "text" }] }],
        });
        running.add(gym);
        await askOnce(gym, "Look at the notes.", "Reviewed the notes.");

        const before = await callDaemon(gym, "GET", "/projects/{project}/share");
        expect(before.status).toBe(404);
        expect(JSON.stringify(before.body)).not.toContain("without project and workspace sharing");

        // Without a Murmur account there is nobody to own a share. That is a state the
        // request conflicts with and the person asking can fix, so it is answered as one
        // rather than as an internal failure a client cannot interpret.
        const unowned = await callDaemon(gym, "POST", "/projects/{project}/share", {
            friends: [{ displayName: "Dana", peerId: "not-a-peer" }],
            mutationId: "mutation-1",
        });
        expect(unowned.status).toBe(409);
        expect(String(unowned.body.error)).toContain("Set up a Murmur account");

        expect(await callDaemon(gym, "GET", "/scope-share-replicas")).toMatchObject({
            body: { replicas: [] },
            status: 200,
        });
    }, 120_000);

    it("replicates an owner's project, its sessions, and their transcripts to a friend", async () => {
        const relay = await MurmurRelayServer.start();
        relays.add(relay);

        const [owner, friend] = await Promise.all([
            createGym({
                files: { "notes.md": "shared project notes\n" },
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
        expect(
            await callDaemon(friend, "POST", `/murmur/friend-requests/${senderId}/answer`, {
                answer: "accept",
            }),
        ).toMatchObject({ status: 200 });
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
            "/projects/{project}/share",
            (response) => response.status === 201,
            "the owner to invite the friend into a shared project",
            {
                friends: [{ displayName: "Dana from Ops", peerId: friendAccount.peerId }],
                mutationId: "mutation-1",
            },
        );
        expect(created.body).toMatchObject({
            members: [expect.objectContaining({ displayName: "Dana from Ops", state: "active" })],
            share: expect.objectContaining({
                memberCount: 1,
                scopeKind: "project",
                state: "active",
            }),
        });
        const shareId = (created.body.share as { shareId: string }).shareId;
        const ownerSessionId = created.sessionId;

        const replicas = await waitFor(
            friend,
            "GET",
            "/scope-share-replicas",
            (response) =>
                (response.body.replicas as { grant: { shareId: string } }[]).some(
                    (replica) => replica.grant.shareId === shareId,
                ),
            "the shared project to appear on the friend's daemon",
        );
        expect(replicas.body.replicas).toMatchObject([
            expect.objectContaining({
                ownerPeerId: ownerAccount.peerId,
                scopeKind: "project",
                state: "active",
            }),
        ]);

        // The friend is offered the project itself and one entry per session in it.
        const index = await waitFor(
            friend,
            "GET",
            `/scope-share-replicas/${shareId}`,
            (response) =>
                ((response.body.entries as { canonicalJson: string }[] | undefined) ?? []).some(
                    (entry) => entry.canonicalJson.includes('"session_index"'),
                ),
            "the project and its session list to replicate to the friend",
        );
        const entries = index.body.entries as { canonicalJson: string; shareSequence: number }[];
        expect(entries[0]?.canonicalJson).toContain('"scope"');
        // Only the folder's own name travels, never the path that leads to it.
        expect(JSON.stringify(entries)).not.toContain("/workspace");

        const history = await waitFor(
            friend,
            "GET",
            `/scope-share-replicas/${shareId}/sessions/${ownerSessionId}/history`,
            (response) =>
                JSON.stringify(response.body.entries ?? []).includes("Look at the notes."),
            "the owner's transcript to replicate inside the shared project",
        );
        expect(history.status).toBe(200);

        // A shared scope has no member write path, and the daemon does not offer one
        // either: unlike a session share, there is no route a member could post to.
        // The transport-level refusal is pinned in ScopeShareService.test.ts, because
        // only a modified client can reach it and no HTTP call ever does.
        expect(
            await callDaemon(friend, "POST", `/scope-share-replicas/${shareId}`, { text: "Hello" }),
        ).toMatchObject({ status: 405 });

        // Stopping the share is authoritative: the friend's replica ends on its own.
        expect(
            await callDaemon(owner, "POST", "/projects/{project}/share/stop", {
                mutationId: "mutation-2",
            }),
        ).toMatchObject({ status: 200 });
        await waitFor(
            friend,
            "GET",
            "/scope-share-replicas",
            (response) =>
                (response.body.replicas as { state: string }[]).every(
                    (replica) => replica.state === "ended",
                ),
            "the friend's replica to end with the share",
        );
    }, 300_000);
});
