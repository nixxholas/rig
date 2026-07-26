import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("project archiving", () => {
    it("archives the root chats and worktrees of a project and restores it on the next session", async () => {
        const gym = await createGym({
            files: {
                "exercise-project-archive.mjs": exerciseProjectArchiveScript,
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node exercise-project-archive.mjs" },
                            id: "exercise-project-archive",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "The project was archived.", type: "text" }] },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Exercise the project archive lifecycle.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("The project was archived.", 30_000);
        expect(screen.text).toContain("The project was archived.");

        const result = JSON.parse(await gym.readFile("project-archive-result.json")) as {
            archivedAt: number;
            attachedSessionStatus: string;
            directoryRemoved: boolean;
            restoredArchivedAt: number | null;
            restoredProjectId: string;
            rootChatArchived: boolean;
            workspaceStatus: string;
        };
        expect(result).toMatchObject({
            attachedSessionStatus: "archived",
            directoryRemoved: true,
            restoredArchivedAt: null,
            rootChatArchived: true,
            workspaceStatus: "archived",
        });
        expect(result.archivedAt).toBeGreaterThan(0);
        expect(result.restoredProjectId).toMatch(/^[a-z0-9]+$/u);
    }, 120_000);
});

const exerciseProjectArchiveScript = String.raw`
import { access, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { execFileSync } from "node:child_process";

execFileSync("git", ["init"], { cwd: "/workspace", stdio: "ignore" });
execFileSync("git", ["config", "user.email", "gym@example.test"], { cwd: "/workspace" });
execFileSync("git", ["config", "user.name", "Rig Gym"], { cwd: "/workspace" });
await writeFile("/workspace/README.md", "project archive fixture\n");
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

const initialState = await requestJson("GET", "/state");
const project = initialState.projects.find((candidate) => candidate.path === "/workspace");
if (project === undefined) throw new Error("The workspace project is missing.");

const created = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    {
        baseRef: "HEAD",
        clientRequestId: "gym-project-archive",
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
const rootChat = await requestJson("POST", "/sessions", { cwd: "/workspace" });

const current = await requestJson("GET", "/projects/" + encodeURIComponent(project.id));
const archived = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/archive",
    undefined,
    { "if-match": '"' + current.project.version + '"' },
);

const archivedState = await requestJson("GET", "/state");
const archivedRootChat = archivedState.sessions.find((candidate) => candidate.id === rootChat.session.id);
const archivedAttached = archivedState.sessions.find((candidate) => candidate.id === attached.session.id);
const archivedWorkspace = archivedState.workspaces.find((candidate) => candidate.id === workspace.id);
if (archivedRootChat === undefined || archivedAttached === undefined) {
    throw new Error("A session of the archived project is missing.");
}
let directoryRemoved = false;
try {
    await access(workspace.path);
} catch {
    directoryRemoved = true;
}

const restored = await requestJson("POST", "/sessions", { cwd: "/workspace" });
const restoredProject = await requestJson("GET", "/projects/" + encodeURIComponent(project.id));

await writeFile(
    "/workspace/project-archive-result.json",
    JSON.stringify({
        archivedAt: archived.project.archivedAt ?? 0,
        attachedSessionStatus: archivedAttached.status,
        directoryRemoved,
        restoredArchivedAt: restoredProject.project.archivedAt ?? null,
        restoredProjectId: restored.session.projectId,
        rootChatArchived: archivedRootChat.archived === true,
        workspaceStatus: archivedWorkspace?.status,
    }),
);
`;
