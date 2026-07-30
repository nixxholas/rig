import { describe, expect, it } from "vitest";

import { parseHostingRepository } from "../parseHostingRepository.js";
import { remoteProjectName } from "../remoteProjectName.js";

describe("git remote identity", () => {
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
