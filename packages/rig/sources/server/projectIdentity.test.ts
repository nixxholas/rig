import { describe, expect, it } from "vitest";

import {
    parseHostingRepository,
    projectNameKey,
    projectStorageKey,
    remoteProjectName,
    validateProjectName,
} from "./projectIdentity.js";

describe("project identity", () => {
    it("normalizes display identity and portable storage keys", () => {
        expect(projectNameKey("Ｒig")).toBe(projectNameKey("rig"));
        expect(projectStorageKey(" Café / API ")).toBe("cafe-api");
        expect(projectStorageKey("Привет мир")).toBe("privet-mir");
        expect(projectStorageKey("🚀")).toBe("project");
        expect(() => validateProjectName(" \u0000 ")).toThrow("control");
    });

    it("derives names from HTTPS, SSH, and SCP remotes without accepting local paths", () => {
        expect(remoteProjectName("https://github.com/slopus/rig.git")).toBe("rig");
        expect(remoteProjectName("ssh://git@github.com/slopus/rig.git")).toBe("rig");
        expect(remoteProjectName("git@github.com:slopus/rig.git")).toBe("rig");
        expect(remoteProjectName("/Users/example/rig.git")).toBeUndefined();
        expect(parseHostingRepository("git@github.com:slopus/rig.git")).toEqual({
            host: "github.com",
            owner: "slopus",
            repository: "rig",
        });
        expect(parseHostingRepository("git@evil.test:slopus/rig.git")).toBeUndefined();
        expect(parseHostingRepository("git@github.com:unexpected/nested/rig.git")).toBeUndefined();
    });
});
