import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("managed workspace setup commands", () => {
    it("finishes every configured command before the workspace accepts an agent", async () => {
        const gym = await createGym({
            files: {
                "exercise-workspace-setup.mjs": exerciseWorkspaceSetupScript,
                "rig.toml": [
                    "[workspace]",
                    "setup_commands = [",
                    '    "printf first > workspace-setup-order.txt",',
                    '    "test \\"$(cat workspace-setup-order.txt)\\" = first && printf -- \\"\\\\nsecond\\\\n\\" >> workspace-setup-order.txt",',
                    "]",
                    "",
                ].join("\n"),
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "node exercise-workspace-setup.mjs" },
                            id: "exercise-workspace-setup",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "The configured workspace is ready.", type: "text" }] },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Create a managed workspace and verify its setup barrier.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("The configured workspace is ready.", 30_000);
        expect(screen.text).toContain("The configured workspace is ready.");
        await expect(gym.readFile("workspace-setup-result.json")).resolves.toBe(
            JSON.stringify({
                setupOrder: "first\nsecond\n",
                workspaceAttached: true,
            }),
        );
    }, 120_000);

    it("uses happy.toml setup commands when rig.toml is absent", async () => {
        const gym = await createGym({
            files: {
                "exercise-workspace-setup.mjs": exerciseWorkspaceSetupScript,
                "happy.toml": [
                    "[workspace]",
                    "setup_commands = [",
                    '    "printf first > workspace-setup-order.txt",',
                    '    "test \\"$(cat workspace-setup-order.txt)\\" = first && printf -- \\"\\\\nsecond\\\\n\\" >> workspace-setup-order.txt",',
                    "]",
                    "",
                ].join("\n"),
            },
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                cmd: "node exercise-workspace-setup.mjs happy.toml",
                            },
                            id: "exercise-happy-workspace-setup",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "The fallback workspace is ready.", type: "text" }] },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Create a managed workspace using the fallback project config.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("The fallback workspace is ready.", 30_000);
        expect(screen.text).toContain("The fallback workspace is ready.");
        await expect(gym.readFile("workspace-setup-result.json")).resolves.toBe(
            JSON.stringify({
                setupOrder: "first\nsecond\n",
                workspaceAttached: true,
            }),
        );
    }, 120_000);
});

const exerciseWorkspaceSetupScript = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { execFileSync } from "node:child_process";

execFileSync("git", ["init"], { cwd: "/workspace", stdio: "ignore" });
execFileSync("git", ["config", "user.email", "gym@example.test"], { cwd: "/workspace" });
execFileSync("git", ["config", "user.name", "Rig Gym"], { cwd: "/workspace" });
await writeFile("/workspace/README.md", "managed workspace setup fixture\n");
const projectConfigName = process.argv[2] ?? "rig.toml";
execFileSync("git", ["add", "README.md", projectConfigName], { cwd: "/workspace" });
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

const created = await requestJson(
    "POST",
    "/projects/" + encodeURIComponent(project.id) + "/workspaces",
    {
        baseRef: "HEAD",
        name: "Configured Setup",
    },
);
let workspace = created.workspace;
const deadline = Date.now() + 20_000;
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

const setupOrder = await readFile(workspace.path + "/workspace-setup-order.txt", "utf8");
const attached = await requestJson("POST", "/sessions", {
    cwd: workspace.path,
    workspaceId: workspace.id,
});
await writeFile(
    "/workspace/workspace-setup-result.json",
    JSON.stringify({
        setupOrder,
        workspaceAttached: attached.session.workspaceId === workspace.id,
    }),
);
`;
