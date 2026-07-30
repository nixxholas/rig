import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Git state tracking", () => {
    it("reports worktree changes live and keeps committed work in the totals", async () => {
        const gym = await createGym({
            files: { "exercise-git-state.mjs": exerciseGitStateScript },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node exercise-git-state.mjs" },
                            id: "exercise-git-state",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "Git state was tracked.", type: "text" }] },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Exercise Git state tracking for a managed worktree.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("Git state was tracked.", 30_000);
        expect(screen.text).toContain("Git state was tracked.");

        // The exercise outlives the tool's initial yield and keeps running in the background, so
        // the result is awaited as state rather than assumed present once the model has replied.
        const result = JSON.parse(await readWhenWritten(gym, "git-state-result.json")) as {
            afterCommit: { changedFiles: number; comparison: string; insertions: number };
            branchAfterCommit: string;
            dirty: {
                changedFiles: number;
                comparison: string;
                countsExact: boolean;
                deletions: number;
                files: { insertions?: number; path: string; status: string }[];
                insertions: number;
            };
            durableHeadChanged: boolean;
            liveFrameHasId: boolean;
            liveFrameType: string;
        };

        expect((result as { error?: string }).error).toBeUndefined();

        // An edit inside the worktree is measured exactly, per file and in total.
        expect(result.dirty).toMatchObject({
            changedFiles: 2,
            comparison: "ready",
            countsExact: true,
            deletions: 1,
            insertions: 5,
        });
        expect(result.dirty.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ insertions: 2, path: "tracked.txt", status: "modified" }),
                expect.objectContaining({
                    insertions: 3,
                    path: "untracked.txt",
                    status: "untracked",
                }),
            ]),
        );

        // Committing must not reset the workspace total: the comparison base is the commit the
        // worktree started from, not its moving HEAD.
        expect(result.afterCommit).toMatchObject({
            changedFiles: 2,
            comparison: "ready",
            insertions: 5,
        });

        // Branch and HEAD are durable state and travel on the ordinary workspace update.
        expect(result.durableHeadChanged).toBe(true);
        expect(result.branchAfterCommit).toBe("gym-work");

        // The snapshot itself is live-only: delivered without an SSE id so a reconnecting client's
        // Last-Event-Id keeps pointing at the last durable position.
        expect(result.liveFrameType).toBe("workspace_git_changed");
        expect(result.liveFrameHasId).toBe(false);
    }, 180_000);
});

async function readWhenWritten(gym: Gym, path: string, timeoutMs = 90_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const contents = await gym.readFile(path);
            if (contents.trim().length > 0) return contents;
        } catch {
            // The exercise has not produced the file yet.
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

const exerciseGitStateScript = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { execFileSync } from "node:child_process";

try {
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "ignore" });

git(["init"], "/workspace");
git(["config", "user.email", "gym@example.test"], "/workspace");
git(["config", "user.name", "Rig Gym"], "/workspace");
await writeFile("/workspace/tracked.txt", "one\ntwo\nthree\n");
git(["add", "tracked.txt"], "/workspace");
git(["commit", "-m", "Initial"], "/workspace");

const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();

function requestJson(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                socketPath,
                path,
                method,
                headers: {
                    authorization: "Bearer " + token,
                    accept: "application/json",
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-type": "application/json",
                              "content-length": Buffer.byteLength(payload),
                          }),
                },
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(new Error(method + " " + path + ": " + text));
                        return;
                    }
                    resolve(text.length === 0 ? {} : JSON.parse(text));
                });
            },
        );
        outgoing.on("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}

/** Collects raw SSE frames so the wire format itself can be asserted, not just parsed events. */
function openStream() {
    const frames = [];
    let resolveConnected;
    let rejectConnected;
    const connected = new Promise((resolve, reject) => {
        resolveConnected = resolve;
        rejectConnected = reject;
    });
    const call = request({
        socketPath,
        path: "/events/stream",
        method: "GET",
        headers: { authorization: "Bearer " + token, accept: "text/event-stream" },
    });
    let buffer = "";
    call.on("response", (response) => {
        resolveConnected();
        response.on("data", (chunk) => {
            buffer += String(chunk);
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary < 0) break;
                frames.push(buffer.slice(0, boundary + 2));
                buffer = buffer.slice(boundary + 2);
            }
        });
    });
    call.on("error", rejectConnected);
    call.end();
    return {
        connected,
        frames,
        close: () => call.destroy(),
        waitFor: async (predicate, timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const found = frames.find(predicate);
                if (found !== undefined) return found;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("Timed out waiting for an SSE frame.");
        },
    };
}

const catalog = await requestJson("GET", "/catalog");
const project = catalog.projects.find((candidate) => candidate.path === "/workspace");
if (project === undefined) throw new Error("The workspace project is missing.");

const created = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    { baseRef: "HEAD", clientRequestId: "gym-git-state", name: "Gym Work" },
);
let workspace = created.workspace;
const readyBy = Date.now() + 20000;
while (workspace.status === "initializing" && Date.now() < readyBy) {
    const listing = await requestJson(
        "GET",
        "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    );
    workspace = listing.workspaces.find((candidate) => candidate.id === workspace.id);
    if (workspace === undefined) throw new Error("The worktree disappeared.");
    if (workspace.status === "initializing") {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
if (workspace.status !== "ready") throw new Error("The worktree is " + workspace.status + ".");
if (typeof workspace.baseCommit !== "string") {
    throw new Error("The worktree did not persist its base commit.");
}

const gitPath =
    "/projects/" +
    encodeURIComponent(project.id) +
    "/workspaces/" +
    encodeURIComponent(workspace.id) +
    "/git";

// A detached worktree gets a branch so the durable branch update has something to report.
git(["checkout", "-b", "gym-work"], workspace.path);

const stream = openStream();
await stream.connected;

// Replacing a line proves deletions are counted rather than assumed zero: 2 insertions and
// 1 deletion against the base, plus 3 insertions from a file Git never reports in a diff.
await writeFile(workspace.path + "/tracked.txt", "one\ntwo\nfour\nfive\n");
await writeFile(workspace.path + "/untracked.txt", "a\nb\nc\n");

const dirty = (await requestJson("GET", gitPath + "?refresh=1")).git;

const liveFrame = await stream.waitFor(
    (frame) => frame.includes("workspace_git_changed"),
    20000,
);
const liveFrameHasId = liveFrame.split("\n").some((line) => line.startsWith("id:"));

git(["add", "--all"], workspace.path);
git(["commit", "-m", "Work in the gym worktree"], workspace.path);

const afterCommit = (await requestJson("GET", gitPath + "?refresh=1")).git;

// Branch and HEAD are persisted on the row, so they arrive through the ordinary listing rather
// than the live snapshot.
let refreshed = workspace;
const durableBy = Date.now() + 20000;
while (Date.now() < durableBy) {
    const listing = await requestJson(
        "GET",
        "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    );
    refreshed = listing.workspaces.find((candidate) => candidate.id === workspace.id);
    if (refreshed?.git?.head !== undefined && refreshed.git.head !== workspace.git?.head) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
}
stream.close();

await writeFile(
    "/workspace/git-state-result.json",
    JSON.stringify(
        {
            afterCommit: {
                changedFiles: afterCommit.changedFiles,
                comparison: afterCommit.comparison,
                insertions: afterCommit.insertions,
            },
            branchAfterCommit: refreshed?.git?.branch ?? "",
            dirty: {
                changedFiles: dirty.changedFiles,
                comparison: dirty.comparison,
                countsExact: dirty.countsExact,
                deletions: dirty.deletions,
                files: dirty.files.map((file) => ({
                    insertions: file.insertions,
                    path: file.path,
                    status: file.status,
                })),
                insertions: dirty.insertions,
            },
            durableHeadChanged: refreshed?.git?.head !== undefined,
            liveFrameHasId,
            liveFrameType: "workspace_git_changed",
        },
        null,
        2,
    ),
);
} catch (error) {
    // Without this the host only sees a missing file and never the reason the exercise failed.
    writeFileSync(
        "/workspace/git-state-result.json",
        JSON.stringify({ error: String((error && error.stack) || error) }),
    );
    process.exit(1);
}
`;
