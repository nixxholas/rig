import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";
import type { GymInferenceRequest } from "../../rig/sources/executor/gym-types.js";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("a chat files itself into a folder", () => {
    it("adopts the folder's physical directory and standing rules in the same turn", async () => {
        let folderId = "";
        let folderPath = "";
        const gym = await createGym({
            environment: { RIG_GYM_RUNTIME: "node" },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    description: "Video production",
                                    name: "Media",
                                    rules: "Always preserve the original footage.",
                                },
                                id: "create-media-folder",
                                name: "create_folder",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    const folder = toolResultJson(request, "create_folder") as {
                        id: string;
                        path: string;
                    };
                    folderId = folder.id;
                    folderPath = folder.path;
                    return {
                        content: [
                            {
                                arguments: { folder_id: folderId },
                                id: "file-chat",
                                name: "set_chat_folder",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 2) {
                    expect(toolResultJson(request, "set_chat_folder")).toMatchObject({
                        folder: { id: folderId, path: folderPath },
                    });
                    expect(request.context.systemPrompt).toContain(
                        "Always preserve the original footage.",
                    );
                    expect(request.context.systemPrompt).toContain(folderPath);
                    return {
                        content: [
                            {
                                arguments: { cmd: "pwd" },
                                id: "read-folder-cwd",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(callIndex).toBe(3);
                expect(toolResultText(request, "exec_command").toLowerCase()).toContain(
                    folderPath.toLowerCase(),
                );
                return {
                    content: [{ text: "FOLDER_CONTEXT_VERIFIED", type: "text" }],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Create the right folder, file this chat there, and verify its context.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("FOLDER_CONTEXT_VERIFIED", 30_000);
        expect(screen.text).toContain("FOLDER_CONTEXT_VERIFIED");
    }, 120_000);
});

function toolResultJson(request: GymInferenceRequest, toolName: string): unknown {
    return JSON.parse(toolResultText(request, toolName)) as unknown;
}

function toolResultText(request: GymInferenceRequest, toolName: string): string {
    const result = [...request.context.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === toolName);
    expect(result).toMatchObject({ isError: false, role: "toolResult", toolName });
    if (result?.role !== "toolResult") throw new Error(`${toolName} returned no tool result.`);
    const content = result.content[0];
    if (typeof content !== "object" || content === null || content.type !== "text") {
        throw new Error(`${toolName} returned no JSON text.`);
    }
    return content.text;
}
