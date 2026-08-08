import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const WORKLET_ICON = solidPng(512, 512, [49, 87, 213, 255]);
const WORKLET_TOOL_NAME = "worklet_same_turn_marker_read_marker";
const WORKLET_MANIFEST = `${JSON.stringify(
    {
        description: "Returns a marker that proves its tool is live.",
        name: "same-turn-marker",
        permissions: { disk: "none", network: "none" },
    },
    null,
    2,
)}\n`;
const WORKLET_SOURCE = [
    'import { defineWorkletTool, Type, worklet } from "happy-worklets";',
    "",
    "enum Marker {",
    '    Value = "SAME_TURN_WORKLET_RESULT",',
    "}",
    "",
    "await worklet.tools([",
    "    defineWorkletTool({",
    '        description: "Returns the same-turn test marker.",',
    "        inputSchema: Type.Object({}),",
    '        name: "read_marker",',
    "        execute: () => ({",
    '            content: [{ text: Marker.Value, type: "text" }],',
    "        }),",
    "    }),",
    "]);",
    'await worklet.ready("Ready to return the marker.");',
    "",
].join("\n");

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("worklet installation", () => {
    it("makes a newly installed worklet tool callable in the same agent run", async () => {
        const gym = await createGym({
            files: {
                "same-turn-marker/DEVELOPMENT.md":
                    "Registers one deterministic tool for the worklet gym test.\n",
                "same-turn-marker/README.md":
                    "Returns a marker so Rig can verify that this worklet is available.\n",
                "same-turn-marker/icon.png": WORKLET_ICON,
                "same-turn-marker/index.ts": WORKLET_SOURCE,
                "same-turn-marker/worklet.json": WORKLET_MANIFEST,
            },
            inference(request, callIndex) {
                const toolNames = request.context.tools?.map((tool) => tool.name) ?? [];
                if (callIndex === 0) {
                    expect(toolNames).toContain("worklet_install");
                    expect(toolNames).not.toContain(WORKLET_TOOL_NAME);
                    return {
                        content: [
                            {
                                arguments: {
                                    iconPath: "/workspace/same-turn-marker/icon.png",
                                    path: "/workspace/same-turn-marker",
                                    permissions: { disk: "none", network: "none" },
                                    sourceDescription: "Gym fixture",
                                },
                                id: "install-same-turn-marker",
                                name: "worklet_install",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    const installResult = request.context.messages.at(-1);
                    if (installResult?.role === "toolResult" && installResult.isError === true) {
                        throw new Error(
                            `Worklet installation failed: ${JSON.stringify(installResult)}`,
                        );
                    }
                    expect(installResult).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "worklet_install",
                    });
                    if (!toolNames.includes(WORKLET_TOOL_NAME)) {
                        throw new Error(
                            `New worklet tool was absent. Available worklet tools: ${JSON.stringify(
                                toolNames.filter((name) => name.startsWith("worklet_")),
                            )}. Install result: ${JSON.stringify(installResult)}`,
                        );
                    }
                    return {
                        content: [
                            {
                                arguments: {},
                                id: "read-same-turn-marker",
                                name: WORKLET_TOOL_NAME,
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(2);
                const toolResult = request.context.messages.at(-1);
                expect(toolResult).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: WORKLET_TOOL_NAME,
                });
                expect(JSON.stringify(toolResult)).toContain("SAME_TURN_WORKLET_RESULT");
                return {
                    content: [{ text: "SAME_TURN_WORKLET_VERIFIED", type: "text" }],
                };
            },
            mode: "docker",
            permissionMode: "full_access",
        });
        running.add(gym);

        gym.terminal.type("Install the local marker worklet and call its tool immediately.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SAME_TURN_WORKLET_VERIFIED", 30_000);
    }, 120_000);
});

function solidPng(
    width: number,
    height: number,
    color: readonly [number, number, number, number],
): Uint8Array {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const row = Buffer.alloc(1 + width * 4);
    for (let offset = 1; offset < row.length; offset += 4) {
        row.set(color, offset);
    }
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    payload.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(payload), chunk.length - 4);
    return chunk;
}

function crc32(bytes: Buffer): number {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
        }
    }
    return (value ^ 0xffffffff) >>> 0;
}
