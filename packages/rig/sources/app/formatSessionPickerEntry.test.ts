import { describe, expect, it } from "vitest";

import type { SessionSummary } from "../protocol/index.js";
import { formatSessionPickerEntry } from "./formatSessionPickerEntry.js";

const NOW = 1_700_000_000_000;

describe("formatSessionPickerEntry", () => {
    it("shows the title, when it last ran, and how much context it holds", () => {
        const entry = formatSessionPickerEntry(
            session({
                lastMessageAt: NOW - 2 * 60 * 60 * 1_000,
                recap: "Rewrote  the\nstartup panel.",
                sessionTokenCount: { lastContextTokens: 34_500, totalTokens: 120_000 },
                title: "Fix the resume picker",
            }),
            { now: NOW, showDirectory: false },
        );

        expect(entry.title).toBe("Fix the resume picker");
        expect(entry.meta).toBe("2 hours ago · 35k context");
        expect(entry.detail).toBe("Rewrote the startup panel.");
        expect(entry.badge).toBeUndefined();
    });

    it("names sessions without a title and omits an empty context size", () => {
        const entry = formatSessionPickerEntry(
            session({ lastMessageAt: NOW - 10_000, titleStatus: "generating" }),
            { now: NOW, showDirectory: false },
        );

        expect(entry.title).toBe("Untitled session");
        expect(entry.meta).toBe("just now");
        expect(entry.detail).toBeUndefined();
    });

    it("adds the directory only when sessions span several of them", () => {
        const summary = session({ cwd: "/tmp/project", recap: "Ran the tests." });

        expect(formatSessionPickerEntry(summary, { now: NOW, showDirectory: true }).detail).toBe(
            "/tmp/project · Ran the tests.",
        );
        expect(formatSessionPickerEntry(summary, { now: NOW, showDirectory: false }).detail).toBe(
            "Ran the tests.",
        );
    });

    it("badges sessions that are waiting on the user", () => {
        const entry = formatSessionPickerEntry(
            session({ unread: { reason: "attention_needed", since: NOW } }),
            { now: NOW, showDirectory: false },
        );

        expect(entry.badge).toBe("Needs attention");
    });
});

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        archived: false,
        createdAt: NOW,
        cwd: "/workspace",
        id: "session-1",
        modelId: "gpt-5",
        orderKey: "a",
        permissionMode: "workspace_write",
        projectId: "project-1",
        providerId: "codex",
        scope: { kind: "project", projectId: "project-1" },
        status: "idle",
        titleStatus: "idle",
        updatedAt: NOW,
        ...overrides,
    };
}
