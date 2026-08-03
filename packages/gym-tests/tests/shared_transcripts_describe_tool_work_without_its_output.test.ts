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
 *
 * Copied verbatim from
 * `session_sharing_is_reachable_and_replicates_the_transcript.test.ts` so this
 * scenario exercises the exact same client boundary without refactoring the
 * original test.
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

interface HistoryEntry {
    readonly canonicalJson: string;
    readonly shareSequence: number;
}

function readEntries(response: ProtocolResponse): HistoryEntry[] {
    return ((response.body.entries as HistoryEntry[] | undefined) ?? []).slice();
}

describe("shared transcripts describe tool work without its output", () => {
    it("hides real tool output at the default and reveals it only when the owner asks", async () => {
        const relay = await MurmurRelayServer.start();
        relays.add(relay);

        // The secret only ever exists as a tool's *output* (the file's body and a
        // command's stderr). It is never part of any prompt, command string, or
        // scripted assistant text, so its presence in a replica can only mean the
        // tool's output crossed the boundary.
        const [owner, friend] = await Promise.all([
            createGym({
                files: {
                    ".env.fixture": "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n",
                    "probe-stderr.txt": "STDERRSEKRIT9TOWN\n",
                },
                inference: [
                    // Turn 1: read a file whose body is the secret.
                    {
                        content: [
                            {
                                arguments: { cmd: "cat .env.fixture" },
                                id: "read-secret",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    },
                    { content: [{ text: "Inspected the fixture.", type: "text" }] },
                    // Turn 2: a command that exits non-zero, emitting the secret to stderr.
                    {
                        content: [
                            {
                                arguments: { cmd: "sh -c 'cat probe-stderr.txt 1>&2; exit 7'" },
                                id: "probe-fail",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    },
                    { content: [{ text: "The probe failed as expected.", type: "text" }] },
                    // Turn 3: the same secret-bearing read, run after the owner opts into full output.
                    {
                        content: [
                            {
                                arguments: { cmd: "cat .env.fixture" },
                                id: "read-secret-again",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    },
                    { content: [{ text: "Re-read the fixture.", type: "text" }] },
                ],
            }),
            createGym({
                inference: [{ content: [{ text: "Standing by.", type: "text" }] }],
            }),
        ]);
        running.add(owner);
        running.add(friend);

        // Two turns run before the session is shared, so both are part of the
        // transcript the friend replicates.
        await askOnce(owner, "Read the env fixture.", "Inspected the fixture.");
        await askOnce(owner, "Run the probe command.", "The probe failed as expected.");
        await askOnce(friend, "Wait for a share.", "Standing by.");

        await joinMurmur(owner, relay.url, "Robin");
        const friendAccount = await joinMurmur(friend, relay.url, "Dana");

        // Become Murmur friends the way two people would.
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

        // Share at the DEFAULT setting: `toolOutput` is deliberately omitted, and
        // the daemon must record that as summaries-only.
        const created = await waitFor(
            owner,
            "POST",
            "/sessions/{session}/share",
            (response) => response.status === 201,
            "the owner to invite the friend into a shared session",
            {
                friends: [{ displayName: "Dana from Ops", peerId: friendAccount.peerId }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            },
        );
        expect(created.body.share).toMatchObject({ toolOutput: "summaries" });
        const shareId = (created.body.share as { shareId: string }).shareId;

        await waitFor(
            friend,
            "GET",
            "/session-share-replicas",
            (response) =>
                (response.body.replicas as { grant: { shareId: string } }[]).some(
                    (replica) => replica.grant.shareId === shareId,
                ),
            "the shared session to appear on the friend's daemon",
        );

        // Wait until the friend has replicated the second turn (the failing probe).
        // Because entries append in order, seeing turn two proves turn one arrived.
        const summariesHistory = await waitFor(
            friend,
            "GET",
            `/session-share-replicas/${shareId}/history`,
            (response) =>
                readEntries(response)
                    .map((entry) => entry.canonicalJson)
                    .join("\n")
                    .includes("The command exited with code 7"),
            "the owner's tool activity to replicate as summaries",
        );
        const summariesEntries = readEntries(summariesHistory);
        const summariesJoined = summariesEntries.map((entry) => entry.canonicalJson).join("\n");

        // The boundary: what the tools *saw* never crosses.
        expect(summariesJoined).not.toContain("AKIAIOSFODNN7EXAMPLE"); // the file's secret value
        expect(summariesJoined).not.toContain("AWS_SECRET_ACCESS_KEY"); // the raw file body
        expect(summariesJoined).not.toContain("STDERRSEKRIT9TOWN"); // the command's stderr text

        // The friend can still follow what the agent *did*: the exact sentences
        // exec_command's own toSharedCall / toSharedResult produce.
        expect(summariesJoined).toContain("Ran the command `cat .env.fixture`.");
        expect(summariesJoined).toContain("The command exited with code 0");
        // A failing command stays legible: its summary names the exit code.
        expect(summariesJoined).toContain("The command exited with code 7");

        // Every replicated entry is a version-2 projection.
        expect(summariesJoined).toContain('"version":2');

        const summariesCount = summariesEntries.length;

        // The owner deliberately, separately opts into full output. This governs
        // only tool calls still to come, never what was already replicated.
        const raised = await callDaemon(owner, "POST", "/sessions/{session}/share/tool-output", {
            mutationId: "mutation-2",
            toolOutput: "full",
        });
        expect(raised.status).toBe(200);
        expect(raised.body.share).toMatchObject({ toolOutput: "full" });

        // One more turn produces the same secret-bearing output under the new setting.
        await askOnce(owner, "Read the env fixture again.", "Re-read the fixture.");

        const fullHistory = await waitFor(
            friend,
            "GET",
            `/session-share-replicas/${shareId}/history`,
            (response) => {
                const entries = readEntries(response);
                if (entries.length <= summariesCount) return false;
                return entries
                    .slice(summariesCount)
                    .map((entry) => entry.canonicalJson)
                    .join("\n")
                    .includes("AKIAIOSFODNN7EXAMPLE");
            },
            "the owner's raised setting to disclose the tool output in new entries",
        );
        const newEntries = readEntries(fullHistory).slice(summariesCount);
        const newJoined = newEntries.map((entry) => entry.canonicalJson).join("\n");

        // The owner's explicit choice is honoured in the newly replicated entries.
        expect(newJoined).toContain("AKIAIOSFODNN7EXAMPLE");
        expect(newJoined).toContain('"version":2');

        // The earlier, summaries-era entries are untouched: the secret did not
        // retroactively appear in what was already private.
        const unchanged = readEntries(fullHistory).slice(0, summariesCount);
        expect(unchanged.map((entry) => entry.canonicalJson).join("\n")).not.toContain(
            "AKIAIOSFODNN7EXAMPLE",
        );

        // The owner's terminal stays healthy throughout.
        const finalScreen = await owner.terminal.snapshot();
        expect(finalScreen.text).toContain("Ask Rig to do anything");
        expect(finalScreen.text).not.toContain("\uFFFD");
    }, 300_000);
});
