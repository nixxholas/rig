import { describe, expect, it } from "vitest";

import {
    parseDockerProjectConfigSelection,
    type DockerProjectManagedNetworkPolicyState,
} from "./loadDockerProjectManagedNetworkPolicy.js";

describe("parseDockerProjectConfigSelection", () => {
    it.each([
        {
            absent: ["happy.toml"],
            marker: "R",
            ready: ["rig.toml"],
        },
        {
            absent: ["rig.toml"],
            marker: "H",
            ready: ["happy.toml"],
        },
        {
            absent: [],
            marker: "B",
            ready: ["rig.toml", "happy.toml"],
        },
        {
            absent: ["happy.toml"],
            marker: "P",
            ready: ["rig.toml"],
        },
    ] satisfies readonly {
        absent: DockerProjectManagedNetworkPolicyState["absentProjectConfigNames"];
        marker: string;
        ready: DockerProjectManagedNetworkPolicyState["readyProjectConfigNames"];
    }[])("maps the $marker selection to protected Docker paths", ({ absent, marker, ready }) => {
        const state = parseDockerProjectConfigSelection(marker);

        expect(state.absentProjectConfigNames).toEqual(absent);
        expect(state.readyProjectConfigNames).toEqual(ready);
        expect(state.projectConfigPlaceholderCreated).toBe(marker === "P");
    });

    it("rejects an unknown selection marker", () => {
        expect(() => parseDockerProjectConfigSelection("X")).toThrow(
            "Could not identify the Docker project's configuration.",
        );
    });
});
