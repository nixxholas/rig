import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const PLUGIN_ICON = new Uint8Array(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);
const PLUGIN_TOOL_NAME = "mcp__Project_Tools___Catalog__list_projects";
const APP_ONLY_TOOL_NAME = "mcp__Project_Tools___Catalog__refresh_app";
const PLUGIN_MANIFEST = `${JSON.stringify(
    {
        description: "Contributes a project catalog tool.",
        entry: "index.ts",
        icon: "icon.png",
        name: "Project Tools",
    },
    null,
    2,
)}\n`;
const PLUGIN_SOURCE = [
    'import { writeFile } from "node:fs/promises";',
    'import { defineMcpTool, happy, Type } from "happy-plugins";',
    "",
    "await happy.mcp.startServer({",
    '    name: "Catalog",',
    "    tools: [",
    "        defineMcpTool({",
    '            description: "List every local Rig project.",',
    "            inputSchema: Type.Object({}),",
    '            name: "list_projects",',
    "            async execute() {",
    '                await writeFile("mcp-executed.txt", "executed\\n");',
    "                const projects = await happy.projects.list();",
    "                return {",
    "                    content: [",
    '                        { text: JSON.stringify(projects), type: "text" },',
    "                    ],",
    "                };",
    "            },",
    "        }),",
    "        defineMcpTool({",
    '            description: "Refresh only the mounted MCP App.",',
    "            inputSchema: Type.Object({}),",
    '            name: "refresh_app",',
    '            visibility: ["app"],',
    "            execute() {",
    '                return { content: [{ text: "refreshed", type: "text" }] };',
    "            },",
    "        }),",
    "    ],",
    "});",
    'console.log("Plugin MCP ready");',
    "await new Promise<void>(() => {});",
    "",
].join("\n");

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("plugin MCP contributions", () => {
    it("lets an ordinary agent call a sandboxed source plugin tool that uses the Happy SDK", async () => {
        const gym = await createGym({
            files: {
                "project-tools/happy.plugin.json": PLUGIN_MANIFEST,
                "project-tools/icon.png": PLUGIN_ICON,
                "project-tools/index.ts": PLUGIN_SOURCE,
            },
            inference(request, callIndex) {
                const toolNames = request.context.tools?.map((tool) => tool.name) ?? [];
                if (callIndex === 0) {
                    expect(toolNames).toContain("plugin_install");
                    expect(toolNames).not.toContain(PLUGIN_TOOL_NAME);
                    return {
                        content: [
                            {
                                arguments: { path: "/workspace/project-tools" },
                                id: "install-project-tools",
                                name: "plugin_install",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(request.context.messages.at(-1)).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "plugin_install",
                    });
                    return { content: [{ text: "PLUGIN_INSTALLED", type: "text" }] };
                }
                if (callIndex === 2) {
                    expect(toolNames).toContain(PLUGIN_TOOL_NAME);
                    expect(toolNames).not.toContain(APP_ONLY_TOOL_NAME);
                    return {
                        content: [
                            {
                                arguments: {},
                                id: "list-projects-through-plugin",
                                name: PLUGIN_TOOL_NAME,
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(3);
                const toolResult = request.context.messages.at(-1);
                expect(toolResult).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: PLUGIN_TOOL_NAME,
                });
                expect(JSON.stringify(toolResult)).toContain("/workspace");
                return { content: [{ text: "PLUGIN_PROJECT_LIST_VERIFIED", type: "text" }] };
            },
            mode: "docker",
            permissionMode: "full_access",
        });
        running.add(gym);

        gym.terminal.type("Install the local Project Tools plugin.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("PLUGIN_INSTALLED", 30_000);

        gym.terminal.type("Use the plugin tool to list my projects.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("PLUGIN_PROJECT_LIST_VERIFIED", 30_000);

        gym.terminal.type("/plugins Project Tools");
        gym.terminal.press("enter");
        const log = await gym.terminal.waitForText("Plugin MCP ready", 10_000);
        expect(log.text).toContain("Project Tools · running");
        expect(log.text).toContain("[stdout] Plugin MCP ready");
        await expect(pluginExecutionMarker(gym)).resolves.toBe("present");
    }, 120_000);

    it("reviews the real plugin MCP boundary in Auto and denies it before plugin execution", async () => {
        const gym = await createGym({
            homeFiles: {
                ".happy/rig/plugins/project-tools/happy.plugin.json": PLUGIN_MANIFEST,
                ".happy/rig/plugins/project-tools/icon.png": PLUGIN_ICON,
                ".happy/rig/plugins/project-tools/index.ts": PLUGIN_SOURCE,
            },
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    )
                ) {
                    expect(callIndex).toBe(1);
                    const boundary = messageText(lastMessage);
                    expect(boundary).toContain("List Projects");
                    expect(boundary).toContain("Project Tools");
                    expect(boundary).toContain("outside Rig’s filesystem sandbox");
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "deny",
                                    rationale:
                                        "The plugin call was not authorized for this Auto turn.",
                                    risk_level: "medium",
                                    user_authorization: "low",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }
                if (callIndex === 0) {
                    const toolNames = request.context.tools?.map((tool) => tool.name) ?? [];
                    expect(toolNames).toContain(PLUGIN_TOOL_NAME);
                    expect(toolNames).not.toContain(APP_ONLY_TOOL_NAME);
                    return {
                        content: [
                            {
                                arguments: {},
                                id: "auto-denied-plugin-project-list",
                                name: PLUGIN_TOOL_NAME,
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(2);
                expect(lastMessage).toMatchObject({
                    isError: true,
                    role: "toolResult",
                    toolName: PLUGIN_TOOL_NAME,
                });
                expect(messageText(lastMessage)).toContain(
                    "The plugin call was not authorized for this Auto turn.",
                );
                return { content: [{ text: "PLUGIN_AUTO_DENIAL_VERIFIED", type: "text" }] };
            },
            mode: "docker",
            permissionMode: "auto",
        });
        running.add(gym);

        gym.terminal.type("Try the Project Tools MCP call only if Auto permits it.");
        gym.terminal.press("enter");
        const denied = await gym.terminal.waitForText("PLUGIN_AUTO_DENIAL_VERIFIED", 30_000);
        expect(denied.text).toContain("Automatic permission review refused calling");

        await expect(pluginExecutionMarker(gym)).resolves.toBe("missing");
    }, 120_000);
});

async function pluginExecutionMarker(gym: Gym): Promise<string> {
    const marker = await gym.runInContainer("bash", [
        "-lc",
        "test -f /home/rig/happy/plugins/project-tools/mcp-executed.txt && printf present || printf missing",
    ]);
    return marker.stdout;
}

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string; type: "text" } =>
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
}
