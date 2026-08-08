import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("managed workspace allocation", () => {
    it("skips stale storage and resolves a session from the allocated cwd", async () => {
        const gym = await createGym({
            files: {
                "exercise-workspace-allocation.mjs": exerciseWorkspaceAllocationScript,
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node exercise-workspace-allocation.mjs" },
                            id: "exercise-workspace-allocation",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "The workspace was allocated.", type: "text" }] },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Exercise workspace allocation with stale storage.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("The workspace was allocated.", 30_000);
        expect(screen.text).toContain("The workspace was allocated.");
        await expect(gym.readFile("workspace-allocation-result.json")).resolves.toBe(
            JSON.stringify({
                // The folder key steps over the stale directory, while the branch the name asks
                // for is free: the two identities no longer share one key.
                branch: "worktree/workspace",
                storageKey: "workspace-3",
                workspaceAttached: true,
            }),
        );
    }, 120_000);
});

const exerciseWorkspaceAllocationScript = String.raw`
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const workspaceRoot =
    process.env.HOME + "/happy/workspaces/" + encodeURIComponent(project.storageKey);
await mkdir(workspaceRoot + "/workspace", { recursive: true });
await writeFile(workspaceRoot + "/workspace/stale.txt", "stale\n");
execFileSync("git", ["branch", "worktree/workspace-2"], { cwd: "/workspace" });

const created = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    {
        baseRef: "HEAD",
        name: "Workspace",
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

const attached = await requestJson("POST", "/sessions", { cwd: workspace.path });
const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: workspace.path,
    encoding: "utf8",
}).trim();
await writeFile(
    "/workspace/workspace-allocation-result.json",
    JSON.stringify({
        branch,
        storageKey: workspace.storageKey,
        workspaceAttached: attached.session.workspaceId === workspace.id,
    }),
);
`;
