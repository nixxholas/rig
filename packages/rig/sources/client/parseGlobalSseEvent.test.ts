import { describe, expect, it } from "vitest";

import { parseGlobalSseEvent } from "./parseGlobalSseEvent.js";

describe("parseGlobalSseEvent", () => {
    it("keeps a live delivery that intentionally carries no event id", () => {
        // The server omits `id:` for live frames so a reconnect stays anchored to the last stored
        // position. Requiring an id here made the entire live channel unreachable through the
        // supported client while the raw-frame tests still passed.
        const frame = [
            "event: project_git_changed",
            `data: ${JSON.stringify({ projectId: "p1", type: "project_git_changed" })}`,
            "",
        ].join("\n");

        const delivery = parseGlobalSseEvent(frame);

        expect(delivery).toMatchObject({ live: true });
        expect(delivery?.event.type).toBe("project_git_changed");
    });

    it("keeps the cursor of a stored delivery", () => {
        const frame = [
            "id: stream.7",
            "event: project_updated",
            `data: ${JSON.stringify({ projectId: "p1", type: "project_updated" })}`,
            "",
        ].join("\n");

        const delivery = parseGlobalSseEvent(frame);

        expect(delivery).toMatchObject({ cursor: "stream.7" });
        expect(delivery !== undefined && "live" in delivery).toBe(false);
    });

    it("ignores a stored event that arrives without a cursor to resume from", () => {
        const frame = [
            "event: project_updated",
            `data: ${JSON.stringify({ projectId: "p1", type: "project_updated" })}`,
            "",
        ].join("\n");

        expect(parseGlobalSseEvent(frame)).toBeUndefined();
    });

    it("ignores comment frames", () => {
        expect(parseGlobalSseEvent(": keepalive\n")).toBeUndefined();
    });
});
