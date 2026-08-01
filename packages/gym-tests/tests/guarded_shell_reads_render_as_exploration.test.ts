import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("guarded shell exploration rendering", () => {
    it("renders guarded reads and a filtered file listing as one Explored block", async () => {
        const gym = await createGym({
            files: {
                "packages/rig/sources/daemon/runDaemon.ts": "export function runDaemon() {}\n",
                "packages/rig/sources/main.ts": "export const main = true;\n",
                "packages/rig/sources/server/startServer.ts": "export function startServer() {}\n",
            },
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                cmd:
                                    "sed -n '1,260p' packages/rig/sources/main.ts 2>/dev/null || true; " +
                                    "sed -n '1,280p' packages/rig/sources/daemon/runDaemon.ts 2>/dev/null || true; " +
                                    "find packages/rig/sources -maxdepth 2 -type f | " +
                                    "rg '/(daemon|server|config|paths|sandbox)/' | sort",
                            },
                            id: "guarded-exploration",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "Inspection complete.", type: "text" }] },
            ],
            rows: 40,
        });
        running.add(gym);

        gym.terminal.type("Inspect the Rig entry points.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitForText("Inspection complete.", 30_000);
        expect(completed.text.match(/• Explored/gu)).toHaveLength(1);
        expect(completed.text).toContain("Read main.ts");
        expect(completed.text).toContain("Read runDaemon.ts");
        expect(completed.text).toContain("List sources");
        expect(completed.text).toContain("Search /(daemon|server|config|paths|sandbox)/");
        expect(completed.text).not.toContain("• Ran sed");
        expect(completed.text).not.toContain("export const main = true");
    }, 30_000);
});
