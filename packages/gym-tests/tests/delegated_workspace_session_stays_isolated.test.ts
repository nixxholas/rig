import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const userMessage = "Rewrite the release notes instead.";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("delegated workspace session", () => {
    it("stays visible, reports completion, and keeps direct user messages isolated", async () => {
        let delegatedSessionId: string | undefined;
        let workspaceId: string | undefined;
        const gym = await createGym({
            cols: 100,
            files: { "CHANGELOG.md": "# Changelog\n" },
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "gym-codex-token",
                        account_id: "gym-account",
                    },
                }),
                "happy/config/happy.toml": "[features]\ncross_workspace = true\n",
            },
            inference(request) {
                const sessionId = request.options.sessionId;
                const lastMessage = request.context.messages.at(-1);
                const lastText = messageText(lastMessage);

                if (lastText.includes("DELEGATED_TASK")) {
                    delegatedSessionId ??= sessionId;
                    return { content: [{ text: "DELEGATE_STARTED_WORK", type: "text" }] };
                }
                if (sessionId === delegatedSessionId) {
                    return { content: [{ text: "DELEGATE_FOLLOWED_THE_USER", type: "text" }] };
                }

                if (lastText.includes("Prepare the changelog work elsewhere.")) {
                    return {
                        content: [
                            {
                                arguments: { cmd: initializeRepositoryCommand },
                                id: "initialize-repository",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (lastMessage?.role === "toolResult" && lastMessage.toolName === "exec_command") {
                    return {
                        content: [
                            {
                                arguments: { base_ref: "HEAD", name: "Changelog" },
                                id: "create-changelog-workspace",
                                name: "create_workspace",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (
                    lastMessage?.role === "toolResult" &&
                    lastMessage.toolName === "create_workspace"
                ) {
                    workspaceId = (JSON.parse(messageText(lastMessage)) as { id: string }).id;
                    return {
                        content: [
                            {
                                arguments: {
                                    model: "openai/gpt-5.6-sol",
                                    prompt: "DELEGATED_TASK: rewrite the changelog.",
                                    provider: "codex",
                                    reasoning_effort: "off",
                                    title: "Update the changelog",
                                    workspace_id: workspaceId,
                                },
                                id: "delegate-changelog",
                                name: "delegate_to_workspace",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (
                    lastMessage?.role === "toolResult" &&
                    lastMessage.toolName === "delegate_to_workspace"
                ) {
                    const result = messageText(lastMessage);
                    if (!result.startsWith("{")) throw new Error(result);
                    delegatedSessionId = (JSON.parse(result) as { sessionId: string }).sessionId;
                    return { content: [{ text: "DELEGATION_STARTED", type: "text" }] };
                }
                if (lastText.includes("<delegated-session-notification>")) {
                    expect(lastText).toContain("Result: DELEGATE_STARTED_WORK");
                    return { content: [{ text: "PARENT_SAW_DELEGATED_RESULT", type: "text" }] };
                }
                return { content: [{ text: "PARENT_IDLE", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            mode: "docker",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 30,
        });
        running.add(gym);

        gym.terminal.type("Prepare the changelog work elsewhere.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("PARENT_SAW_DELEGATED_RESULT", 60_000);
        expect(workspaceId).toBeTypeOf("string");
        expect(delegatedSessionId).toBeTypeOf("string");

        // The delegated conversation belongs in the user's own session list, beside the one that
        // started it, rather than hidden inside it as a subagent.
        const listed = await gym.runInContainer("node", ["-e", requestScript("GET", "/sessions")], {
            timeoutMs: 30_000,
        });
        const sessions = (
            JSON.parse(listed.stdout) as {
                sessions: readonly { id: string; workspaceId?: string }[];
            }
        ).sessions;
        expect(sessions.map((session) => session.id)).toContain(delegatedSessionId);
        expect(sessions.find((session) => session.id === delegatedSessionId)?.workspaceId).toBe(
            workspaceId,
        );
        const delegatorSessionId = sessions.find(
            (session) => session.id !== delegatedSessionId,
        )?.id;
        expect(delegatorSessionId).toBeTypeOf("string");

        // A direct user submission is accepted by the delegated conversation but never copied
        // into the delegator's durable events. The removed implementation committed that parent
        // notification synchronously before this request returned, so this assertion has no race.
        await gym.runInContainer(
            "node",
            [
                "-e",
                requestScript("POST", `/sessions/${delegatedSessionId!}/messages`, {
                    text: userMessage,
                }),
            ],
            { timeoutMs: 30_000 },
        );
        const parentEvents = await gym.runInContainer(
            "node",
            ["-e", requestScript("GET", `/sessions/${delegatorSessionId!}/events`)],
            { timeoutMs: 30_000 },
        );
        expect(parentEvents.stdout).not.toContain(userMessage);
        expect((await gym.terminal.snapshot()).text).not.toContain("The user replied in");
    }, 240_000);
});

function messageText(message: { content?: unknown } | undefined): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block): block is { text: string; type: "text" } => block.type === "text")
        .map((block) => block.text)
        .join("");
}

const initializeRepositoryCommand = [
    "git init -q",
    "git config user.email gym@example.test",
    "git config user.name 'Rig Gym'",
    "git add CHANGELOG.md",
    "git commit -q -m Initial",
].join(" && ");

function requestScript(
    method: "GET" | "POST",
    path: string,
    payload?: Readonly<Record<string, unknown>>,
): string {
    return String.raw`
const { readFileSync } = require("node:fs");
const { request } = require("node:http");

const directory = "/tmp/rig-" + process.getuid();
const token = readFileSync(directory + "/token", "utf8").trim();
const payload = ${payload === undefined ? "undefined" : JSON.stringify(JSON.stringify(payload))};
const outgoing = request(
    {
        socketPath: directory + "/server.sock",
        path: ${JSON.stringify(path)},
        method: ${JSON.stringify(method)},
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
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
            body += chunk;
        });
        response.on("end", () => {
            if ((response.statusCode ?? 500) >= 400) {
                process.exitCode = 1;
                console.error(body);
                return;
            }
            process.stdout.write(body);
        });
    },
);
outgoing.on("error", (error) => {
    process.exitCode = 1;
    console.error(error.message);
});
outgoing.end(payload);
`;
}
