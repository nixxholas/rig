import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("managed shell network in the Linux sandbox", () => {
    it("starts the command through the isolated proxy bridge", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "printf NETWORK_COMMAND_RAN > marker.txt",
                                },
                                id: "managed-network-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                const result = request.context.messages.at(-1);
                if (result?.role === "toolResult" && result.isError) {
                    throw new Error(JSON.stringify(result, undefined, 2));
                }
                expect(result).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                return {
                    content: [{ text: "MANAGED_NETWORK_BRIDGE_READY", type: "text" }],
                };
            },
            files: {
                "rig.toml": '[network]\nallowed_domains = ["example.com"]\n',
            },
            mode: "docker",
            permissionMode: "workspace_write",
        });
        running.add(gym);

        gym.terminal.type("Run the networked command.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("MANAGED_NETWORK_BRIDGE_READY", 30_000);
        await expect(gym.readFile("marker.txt")).resolves.toBe("NETWORK_COMMAND_RAN");
    }, 120_000);

    it("keeps proxy-aware localhost traffic inside the isolated namespace", async () => {
        const gym = await createGym({
            files: {
                "rig.toml": '[network]\nallowed_domains = ["example.com"]\n',
            },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: `node -e 'const fs=require("node:fs");const http=require("node:http");const server=http.createServer((_,response)=>response.end("loopback-ok"));server.listen(0,"127.0.0.1",async()=>{try{const result=await fetch("http://localhost:"+server.address().port);fs.writeFileSync("loopback.txt",await result.text())}finally{server.close()}})'`,
                                },
                                id: "local-binding-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                const result = request.context.messages.at(-1);
                if (result?.role === "toolResult" && result.isError) {
                    throw new Error(JSON.stringify(result, undefined, 2));
                }
                expect(result).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                return {
                    content: [{ text: "LOCAL_BINDING_READY", type: "text" }],
                };
            },
            mode: "docker",
            permissionMode: "workspace_write",
        });
        running.add(gym);

        gym.terminal.type("Bind an ephemeral loopback port.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("LOCAL_BINDING_READY", 30_000);
        await expect(gym.readFile("loopback.txt")).resolves.toBe("loopback-ok");
    }, 120_000);
});
