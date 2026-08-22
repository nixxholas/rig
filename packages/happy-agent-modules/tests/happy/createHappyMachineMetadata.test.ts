import { describe, expect, it } from "vitest";

import { createHappyMachineMetadata } from "../../sources/happy/index.js";
import type { HappyConnectionConfiguration } from "../../sources/happy/index.js";

const configuration: HappyConnectionConfiguration = {
    credentials: {
        encryption: { secret: new Uint8Array(32), type: "legacy" },
        token: "token",
    },
    credentialsPath: "/home/user/.happy/access.key",
    happyHome: "/home/user/.rig/happy",
    imported: false,
    machineId: "machine-1",
    serverUrl: "https://api.happy.example",
};

describe("Happy machine metadata", () => {
    it("keeps the deployed Happy identity fields alongside Rig metadata", () => {
        const metadata = createHappyMachineMetadata({
            configuration,
            models: [
                {
                    defaultEffort: "medium",
                    effortLevels: ["low", "medium", "high"],
                    id: "openai/gpt-5.6-sol",
                    name: "GPT-5.6 Sol",
                    providerId: "codex",
                    serviceTiers: [],
                },
            ],
            version: "1.2.3",
        });

        expect(metadata).toMatchObject({
            client: { id: "rig", name: "Rig", version: "1.2.3" },
            happiestCliVersion: "1.2.3",
            happiestHomeDir: "/home/user/.rig/happy",
            machineKind: "rig",
            rigOnly: true,
        });
    });
});
