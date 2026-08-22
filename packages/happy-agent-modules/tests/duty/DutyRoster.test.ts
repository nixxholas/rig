import { describe, expect, it } from "vitest";

import { dutyAgentId, parseDutyRoster } from "../../sources/duty/index.js";

const entry = `
[[duty]]
id = "release-warden"
charter = "Keep the release branch green."
trigger = "Sweep the branch."
project = "/srv/repo"
permission_ceiling = "workspace_write"
allowed_tools = ["read_file", "shell"]
`;

describe("readDutyRoster", () => {
    it("gives each tenure and project a distinct stable holder", () => {
        const first = dutyAgentId("release-warden", "tenure-1", "/srv/repo");
        expect(first).toBe(dutyAgentId("release-warden", "tenure-1", "/srv/repo"));
        expect(dutyAgentId("release-warden", "tenure-2", "/srv/repo")).not.toBe(first);
        expect(dutyAgentId("release-warden", "tenure-1", "/srv/other")).not.toBe(first);
    });

    it("reads a declaration and defaults its first tenure", () => {
        const roster = parseDutyRoster(entry);
        expect(roster.authoritative).toBe(true);
        expect(roster.notices).toEqual([]);
        expect(roster.declarations).toEqual([
            {
                allowedTools: ["read_file", "shell"],
                charter: "Keep the release branch green.",
                dutyId: "release-warden",
                permissionCeiling: "workspace_write",
                project: "/srv/repo",
                tenureId: "tenure-1",
                trigger: "Sweep the branch.",
            },
        ]);
    });

    it("reads an interval and holds it inside the supported bounds", () => {
        const every = (value: string): unknown =>
            parseDutyRoster(`${entry}every = "${value}"`).declarations[0]?.every;
        expect(every("30m")).toBe(1_800_000);
        expect(every("2 hours")).toBe(7_200_000);
        expect(every("1m")).toBe(60_000);

        for (const rejected of ["30s", "48h", "soon", "0m"]) {
            const roster = parseDutyRoster(`${entry}every = "${rejected}"`);
            expect(roster.authoritative).toBe(false);
            expect(roster.declarations).toEqual([]);
            expect(roster.notices).toHaveLength(1);
        }
    });

    it("treats a missing roster section as an empty roster", () => {
        expect(parseDutyRoster("")).toEqual({
            authoritative: true,
            declarations: [],
            notices: [],
        });
        expect(parseDutyRoster("[unrelated]\nkey = 1")).toEqual({
            authoritative: true,
            declarations: [],
            notices: [],
        });
    });

    it("skips an unusable declaration and keeps the ones around it", () => {
        const roster = parseDutyRoster(`
[[duty]]
id = "first"
charter = "One."
trigger = "Go."
project = "relative/path"
permission_ceiling = "read_only"
allowed_tools = []

${entry}
`);
        expect(roster.declarations.map((one) => one.dutyId)).toEqual(["release-warden"]);
        expect(roster.authoritative).toBe(false);
        expect(roster.notices).toEqual([
            expect.stringContaining("project must be an absolute path"),
        ]);
    });

    it("refuses two declarations claiming one Duty ID", () => {
        const roster = parseDutyRoster(`${entry}\n${entry}`);
        expect(roster.authoritative).toBe(false);
        expect(roster.declarations).toHaveLength(1);
        expect(roster.notices).toEqual([expect.stringContaining("repeats the duty ID")]);
    });

    it("refuses a setting it does not know and unparsable TOML", () => {
        expect(parseDutyRoster(`${entry}escalate = true`)).toMatchObject({
            authoritative: false,
            notices: [expect.stringContaining('"escalate" is not a Duty setting')],
        });
        expect(parseDutyRoster("[[duty]\nid = ")).toMatchObject({
            authoritative: false,
            notices: [expect.stringContaining("not valid TOML")],
        });
        expect(parseDutyRoster("duty = 4")).toMatchObject({
            authoritative: false,
            notices: [expect.stringContaining("must be an array of tables")],
        });
    });
});
