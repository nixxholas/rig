import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("delegated workspace session", () => {
    it("stays visible to the user and reports their takeover to the delegator", async () => {
        let delegatorSessionId: string | undefined;
        let delegatedSessionId: string | undefined;
        let workspaceId: string | undefined;
        let delegatorSawUserMessage = false;
        const gym = await createGym({
            cols: 100,
            files: { "CHANGELOG.md": "# Changelog\n" },
            homeFiles: { "happy/config/happy.toml": "[features]\ncross_workspace = true\n" },
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

                delegatorSessionId ??= sessionId;
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
                                    prompt: "DELEGATED_TASK: rewrite the changelog.",
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
                    delegatedSessionId = (
                        JSON.parse(messageText(lastMessage)) as { sessionId: string }
                    ).sessionId;
                    return { content: [{ text: "DELEGATION_STARTED", type: "text" }] };
                }
                if (lastText.includes("<delegated-session-notification>")) {
                    if (lastText.includes("Rewrite the release notes instead.")) {
                        expect(lastText).toContain("They are steering it now.");
                        delegatorSawUserMessage = true;
                        return { content: [{ text: "PARENT_SAW_USER_TAKEOVER", type: "text" }] };
                    }
                    expect(lastText).toContain("Result: DELEGATE_STARTED_WORK");
                    return { content: [{ text: "PARENT_SAW_DELEGATED_RESULT", type: "text" }] };
                }
                return { content: [{ text: "PARENT_IDLE", type: "text" }] };
            },
            mode: "docker",
            rows: 30,
        });
        running.add(gym);

        gym.terminal.type("Prepare the changelog work elsewhere.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("PARENT_SAW_DELEGATED_RESULT", 60_000);
        expect(workspaceId).toBeTypeOf("string");
        expect(delegatedSessionId).toBeTypeOf("string");
        expect(delegatedSessionId).not.toBe(delegatorSessionId);

        // The delegated conversation belongs in the user's own session list, beside the one that
        // started it, rather than hidden inside it as a subagent.
        const listed = await gym.runInContainer("node", ["-e", listSessionsScript], {
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

        // The user writes into the delegated conversation the way any Rig client does.
        await gym.runInContainer("node", ["-e", userMessageScript(delegatedSessionId!)], {
            timeoutMs: 30_000,
        });

        const takeover = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("PARENT_SAW_USER_TAKEOVER"),
            "delegator acknowledging the user's takeover",
            60_000,
        );
        expect(delegatorSawUserMessage).toBe(true);
        expect(takeover.text).toContain("The user replied in");
        expect(takeover.text).not.toContain("delegated-session-notification");
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

const listSessionsScript = String.raw`
const { readFileSync } = require("node:fs");
const { request } = require("node:http");

const directory = "/tmp/rig-" + process.getuid();
const token = readFileSync(directory + "/token", "utf8").trim();
const outgoing = request(
    {
        socketPath: directory + "/server.sock",
        path: "/sessions",
        method: "GET",
        headers: { authorization: "Bearer " + token, accept: "application/json" },
    },
    (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
            body += chunk;
        });
        response.on("end", () => {
            process.stdout.write(body);
        });
    },
);
outgoing.on("error", (error) => {
    process.exitCode = 1;
    console.error(error.message);
});
outgoing.end();
`;

function userMessageScript(sessionId: string): string {
    return String.raw`
const { readFileSync } = require("node:fs");
const { request } = require("node:http");

const directory = "/tmp/rig-" + process.getuid();
const token = readFileSync(directory + "/token", "utf8").trim();
const payload = JSON.stringify({ text: "Rewrite the release notes instead." });
const outgoing = request(
    {
        socketPath: directory + "/server.sock",
        path: "/sessions/${sessionId}/messages",
        method: "POST",
        headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
        },
    },
    (response) => {
        if (response.statusCode !== 202) {
            process.exitCode = 1;
            console.error("unexpected status " + response.statusCode);
        }
        response.resume();
        response.on("end", () => {});
    },
);
outgoing.on("error", (error) => {
    process.exitCode = 1;
    console.error(error.message);
});
outgoing.end(payload);
`;
}
