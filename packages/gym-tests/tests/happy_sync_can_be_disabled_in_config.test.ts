import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";
import { libsqlCommonJsScript } from "./libsqlScript.js";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Happy configuration", () => {
    it("keeps synchronization disabled when the machine config turns it off", async () => {
        const gym = await createGym({
            homeFiles: {
                ".happy/access.key": JSON.stringify({
                    secret: Buffer.alloc(32, 7).toString("base64"),
                    token: "happy-gym-token",
                }),
                "happy/config/happy.toml": "[settings]\nhappy_integration = false\n",
            },
            inference: [
                {
                    content: [{ text: "Local-only session completed.", type: "text" }],
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Work without Happy synchronization.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Local-only session completed.", 30_000);

        const inspection = await gym.runInContainer("node", [
            "-e",
            libsqlCommonJsScript(`
const fs = require("node:fs");
const database = await openDatabase("/home/rig/.server/sessions.sqlite", true);
let sessions;
try {
    sessions = (
        await database.execute("select count(*) as count from happy_sessions")
    ).rows[0].count;
} finally {
    await database.close();
}
const copied = fs.existsSync("/home/rig/.happy/rig/happy/access.key");
process.stdout.write(JSON.stringify({ copied, sessions }));
`),
        ]);

        expect(JSON.parse(inspection.stdout)).toEqual({ copied: false, sessions: 0 });
    }, 120_000);

    it("keeps synchronization disabled when the environment override is set", async () => {
        const gym = await createGym({
            environment: { RIG_DISABLE_HAPPY_SYNC: "1" },
            homeFiles: {
                ".happy/access.key": JSON.stringify({
                    secret: Buffer.alloc(32, 8).toString("base64"),
                    token: "happy-gym-token",
                }),
            },
            inference: [
                {
                    content: [{ text: "Environment-disabled session completed.", type: "text" }],
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Work without Happy synchronization from this environment.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Environment-disabled session completed.", 30_000);

        const inspection = await gym.runInContainer("node", [
            "-e",
            libsqlCommonJsScript(`
const fs = require("node:fs");
const database = await openDatabase("/home/rig/.server/sessions.sqlite", true);
let sessions;
try {
    sessions = (
        await database.execute("select count(*) as count from happy_sessions")
    ).rows[0].count;
} finally {
    await database.close();
}
const copied = fs.existsSync("/home/rig/.happy/rig/happy/access.key");
process.stdout.write(JSON.stringify({ copied, sessions }));
`),
        ]);

        expect(JSON.parse(inspection.stdout)).toEqual({ copied: false, sessions: 0 });
    }, 120_000);
});
