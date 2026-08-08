import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../protocol/index.js";
import { createSessionPicker, fitSessionPickerToViewport } from "./createSessionPicker.js";

const NOW = 1_700_000_000_000;

describe("createSessionPicker", () => {
    it("renders each session as a titled row with its recap and context size", () => {
        const picker = createSessionPicker({
            confirmVerb: "resume",
            now: () => NOW,
            onCancel: vi.fn(),
            onSelect: vi.fn(),
            sessions: [
                session({
                    id: "first",
                    lastMessageAt: NOW - 90_000,
                    recap: "Reworked the startup screen.",
                    sessionTokenCount: { lastContextTokens: 34_500, totalTokens: 90_000 },
                    title: "Startup polish",
                }),
                session({ id: "second", title: "Docker sandbox" }),
            ],
            showDirectory: false,
            subtitle: "2 saved sessions in ~/dev/rig.",
            title: "Resume a session",
        });

        const rendered = stripAnsi(picker.render(80).join("\n"));

        expect(rendered).toContain("Resume a session");
        expect(rendered).toContain("2 saved sessions in ~/dev/rig.");
        expect(rendered).toContain("❯ Startup polish");
        expect(rendered).toContain("1 minute ago · 35k context");
        expect(rendered).toContain("Reworked the startup screen.");
        expect(rendered).toContain("Docker sandbox");
        expect(rendered).toContain("Use ↑/↓ to move, Enter to resume, Esc to cancel.");
    });

    it("names what Enter does, so forking never offers to resume", () => {
        const picker = createSessionPicker({
            confirmVerb: "fork",
            now: () => NOW,
            onCancel: vi.fn(),
            onSelect: vi.fn(),
            sessions: [session({ id: "first" })],
            showDirectory: false,
            subtitle: "",
            title: "Fork a session",
        });

        const rendered = stripAnsi(picker.render(80).join("\n"));

        expect(rendered).toContain("Use ↑/↓ to move, Enter to fork, Esc to cancel.");
        expect(rendered).not.toContain("Enter to resume");
    });

    it("moves the pointer and resumes the highlighted session", () => {
        const onSelect = vi.fn();
        const picker = createSessionPicker({
            confirmVerb: "resume",
            now: () => NOW,
            onCancel: vi.fn(),
            onSelect,
            sessions: [session({ id: "first" }), session({ id: "second" })],
            showDirectory: false,
            subtitle: "",
            title: "Resume a session",
        });

        picker.handleInput?.("\x1b[B");
        picker.handleInput?.("\r");

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect.mock.calls[0]?.[0]?.id).toBe("second");
    });

    it("cancels on escape", () => {
        const onCancel = vi.fn();
        const picker = createSessionPicker({
            confirmVerb: "resume",
            now: () => NOW,
            onCancel,
            onSelect: vi.fn(),
            sessions: [session({ id: "first" })],
            showDirectory: false,
            subtitle: "",
            title: "Resume a session",
        });

        picker.handleInput?.("\x1b");

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("scrolls the highlighted session into view inside a short terminal", () => {
        const sessions = Array.from({ length: 10 }, (_, index) =>
            session({ id: `session-${index}`, title: `Session ${index}` }),
        );
        const picker = createSessionPicker({
            confirmVerb: "resume",
            now: () => NOW,
            onCancel: vi.fn(),
            onSelect: vi.fn(),
            sessions,
            showDirectory: false,
            subtitle: "",
            title: "Resume a session",
        });

        fitSessionPickerToViewport(picker, 80, 14);
        for (let step = 0; step < 9; step += 1) picker.handleInput?.("\x1b[B");
        const rendered = stripAnsi(picker.render(80).join("\n"));

        expect(rendered).toContain("❯ Session 9");
        expect(rendered).not.toContain("Session 0");
    });

    it("keeps every row inside a narrow terminal", () => {
        const picker = createSessionPicker({
            confirmVerb: "resume",
            now: () => NOW,
            onCancel: vi.fn(),
            onSelect: vi.fn(),
            sessions: [
                session({
                    recap: "A very long recap that would otherwise overflow the terminal.",
                    title: "A very long session title that would otherwise overflow",
                }),
            ],
            showDirectory: false,
            subtitle: "1 saved session in a directory with a rather long name.",
            title: "Resume a session",
        });

        for (const line of picker.render(30)) expect(visibleWidth(line)).toBe(30);
    });
});

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        archived: false,
        createdAt: NOW,
        cwd: "/workspace",
        id: "session-1",
        ownerInstanceId: "alocalinstance00000000001",
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

function stripAnsi(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "") {
            result += value[index];
            continue;
        }
        while (index < value.length && value[index] !== "m") index += 1;
    }
    return result;
}
