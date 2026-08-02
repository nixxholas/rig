import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("TypeScript plugins", () => {
    it("runs an installed TypeScript plugin and lets its sandboxed process call Rig", async () => {
        const installDirectory = "/home/rig/.happy/rig/plugins/project-counter";
        const dataDirectory = "/home/rig/happy/plugins/project-counter";
        const gym = await createGym({
            homeFiles: {
                ".happy/rig/plugins/project-counter/icon.png": PNG_SIGNATURE,
                ".happy/rig/plugins/project-counter/index.ts": [
                    'import { writeFile } from "node:fs/promises";',
                    'import { happy } from "happy-plugins";',
                    "",
                    "const projects = await happy.projects.list();",
                    'await writeFile("started.txt", `ready:${projects.length}\\n`);',
                    'console.log("Plugin API ready");',
                    "await new Promise<void>(() => {});",
                    "",
                ].join("\n"),
                ".happy/rig/plugins/project-counter/happy.plugin.json": `${JSON.stringify(
                    {
                        description: "Records how many projects Rig knows.",
                        icon: "icon.png",
                        main: "index.ts",
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

        // The plugin writes into the folder it owns rather than where Rig installed its code.
        const started = await gym.runInContainer(
            "bash",
            [
                "-lc",
                `for attempt in $(seq 1 200); do test -f ${dataDirectory}/started.txt && break; sleep 0.05; done; if ! test -f ${dataDirectory}/started.txt; then cat ${installDirectory}/plugin.log 2>/dev/null || true; cat /tmp/rig-1000/server.log; exit 1; fi; cat ${dataDirectory}/started.txt`,
            ],
            { timeoutMs: 15_000 },
        );
        expect(started.stdout).toMatch(/ready:\d+\n/u);

        const log = await gym.runInContainer("cat", [`${installDirectory}/plugin.log`]);
        expect(log.stdout).toContain("[stdout] Plugin API ready");

        const installed = await gym.runInContainer("ls", ["-a", installDirectory]);
        expect(installed.stdout).not.toContain("started.txt");
    }, 30_000);
});
