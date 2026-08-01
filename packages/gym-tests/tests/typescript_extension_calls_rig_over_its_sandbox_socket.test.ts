import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("TypeScript extensions", () => {
    it("builds an installed extension and lets its sandboxed process call Rig", async () => {
        const extensionDirectory = "/home/rig/happy/extensions/project-counter";
        const gym = await createGym({
            homeFiles: {
                "happy/extensions/project-counter/icon.png": PNG_SIGNATURE,
                "happy/extensions/project-counter/index.ts": [
                    'import { writeFile } from "node:fs/promises";',
                    'import { happy } from "happy-plugins";',
                    "",
                    "const projects = await happy.projects.list();",
                    'await writeFile("started.txt", `ready:${projects.length}\\n`);',
                    'console.log("Extension API ready");',
                    "await new Promise<void>(() => {});",
                    "",
                ].join("\n"),
                "happy/extensions/project-counter/happy.plugin.json": `${JSON.stringify(
                    {
                        description: "Records how many projects Rig knows.",
                        entry: "index.ts",
                        icon: "icon.png",
                        name: "Project Counter",
                    },
                    null,
                    2,
                )}\n`,
            },
            inference: [],
            mode: "docker",
        });
        running.add(gym);

        const started = await gym.runInContainer(
            "bash",
            [
                "-lc",
                `for attempt in $(seq 1 200); do test -f ${extensionDirectory}/started.txt && break; sleep 0.05; done; if ! test -f ${extensionDirectory}/started.txt; then cat ${extensionDirectory}/.happy/extension.log 2>/dev/null || true; cat /tmp/rig-1000/server.log; exit 1; fi; cat ${extensionDirectory}/started.txt`,
            ],
            { timeoutMs: 15_000 },
        );
        expect(started.stdout).toMatch(/ready:\d+\n/u);

        const log = await gym.runInContainer("cat", [`${extensionDirectory}/.happy/extension.log`]);
        expect(log.stdout).toContain("[stdout] Extension API ready");
    }, 30_000);
});
