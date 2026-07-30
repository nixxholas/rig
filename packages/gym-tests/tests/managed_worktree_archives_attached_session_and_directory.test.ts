import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("managed project worktrees", () => {
    it("creates a worktree and archives its attached session before deleting the directory", async () => {
        const gym = await createGym({
            files: {
                "exercise-managed-worktree.mjs": exerciseManagedWorktreeScript,
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node exercise-managed-worktree.mjs" },
                            id: "exercise-managed-worktree",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "The managed worktree was archived.", type: "text" }] },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Exercise the managed project worktree lifecycle.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("The managed worktree was archived.", 30_000);
        expect(screen.text).toContain("The managed worktree was archived.");

        const result = JSON.parse(await gym.readFile("managed-worktree-result.json")) as {
            directoryRemoved: boolean;
            projectId: string;
            sessionStatus: string;
            workspaceStatus: string;
        };
        expect(result).toMatchObject({
            directoryRemoved: true,
            sessionStatus: "archived",
            workspaceStatus: "archived",
        });
        expect(result.projectId).toMatch(/^[a-z0-9]+$/u);
    }, 120_000);
});

const exerciseManagedWorktreeScript = String.raw`
import { access, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { execFileSync } from "node:child_process";

execFileSync("git", ["init"], { cwd: "/workspace", stdio: "ignore" });
execFileSync("git", ["config", "user.email", "gym@example.test"], { cwd: "/workspace" });
execFileSync("git", ["config", "user.name", "Rig Gym"], { cwd: "/workspace" });
await writeFile("/workspace/README.md", "managed worktree fixture\n");
execFileSync("git", ["add", "README.md"], { cwd: "/workspace" });
execFileSync("git", ["commit", "-m", "Initial"], { cwd: "/workspace", stdio: "ignore" });

const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();

function requestJson(method, path, body, headers = {}) {
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
                    ...headers,
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
                        reject(new Error(text));
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

const initialCatalog = await requestJson("GET", "/catalog");
const project = initialCatalog.projects.find((candidate) => candidate.path === "/workspace");
if (project === undefined) throw new Error("The workspace project is missing.");

const created = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    {
        baseRef: "HEAD",
        clientRequestId: "gym-managed-worktree",
        name: "Gym Worktree",
    },
);
let workspace = created.workspace;
const deadline = Date.now() + 10_000;
while (workspace.status === "initializing" && Date.now() < deadline) {
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
if (workspace.status !== "ready") {
    throw new Error("The worktree did not become ready: " + JSON.stringify(workspace));
}

const attached = await requestJson("POST", "/sessions", {
    cwd: workspace.path,
    workspaceId: workspace.id,
});
const archived = await requestJson(
    "POST",
    "/projects/" +
        encodeURIComponent(project.id) +
        "/workspaces/" +
        encodeURIComponent(workspace.id) +
        "/archive",
    undefined,
    { "if-match": '"' + workspace.version + '"' },
);
const sessions = await requestJson("GET", "/sessions?archived=all");
const session = sessions.sessions.find((candidate) => candidate.id === attached.session.id);
if (session === undefined) throw new Error("The attached session is missing.");
let directoryRemoved = false;
try {
    await access(workspace.path);
} catch {
    directoryRemoved = true;
}
await writeFile(
    "/workspace/managed-worktree-result.json",
    JSON.stringify({
        directoryRemoved,
        projectId: project.id,
        sessionStatus: session.status,
        workspaceStatus: archived.workspace.status,
    }),
);
`;
