import { describe, expect, it } from "vitest";

import type { ProtocolHttpClient } from "../client/index.js";
import type { ListSessionsOptions, SessionSummary } from "../protocol/index.js";
import { resolveStartupSessionId } from "./resolveStartupSessionId.js";
import type { StartupStatusApp } from "./StartupStatusApp.js";

const NOW = 1_700_000_000_000;
const CWD = "/workspace";

describe("resolveStartupSessionId", () => {
    it("offers every saved session in the directory, however it was left", async () => {
        const offered = await offeredSessions([
            session({ id: "running", status: "running" }),
            session({ id: "settled", status: "completed" }),
            session({ id: "abandoned", status: "aborted" }),
        ]);

        expect(offered).toEqual(["running", "settled", "abandoned"]);
    });

    it("includes sessions the TUI archived when it closed", async () => {
        let requested: ListSessionsOptions | undefined;
        let offered: readonly string[] = [];
        await resolveStartupSessionId({
            client: {
                listSessions: async (options?: number | ListSessionsOptions) => {
                    requested = options as ListSessionsOptions;
                    return {
                        sessions: [
                            session({
                                archived: true,
                                id: "closed-tui",
                                lastMessageAt: NOW - 1_000,
                            }),
                            session({ id: "still-listed", lastMessageAt: NOW - 60_000 }),
                        ],
                    };
                },
            } as unknown as ProtocolHttpClient,
            cwd: CWD,
            selection: { command: "resume", selection: { all: false, last: false } },
            startup: stubStartup((picker) => {
                offered = picker.sessions.map((entry) => entry.id);
                return undefined;
            }),
        });

        expect(requested).toMatchObject({ archived: "all" });
        expect(offered).toEqual(["closed-tui", "still-listed"]);
    });

    it("orders sessions by when they last saw a message", async () => {
        const offered = await offeredSessions([
            session({ id: "middle", lastMessageAt: NOW - 5_000, orderKey: "a" }),
            session({ id: "oldest", lastMessageAt: NOW - 90_000, orderKey: "b" }),
            session({ id: "newest", lastMessageAt: NOW - 100, orderKey: "c" }),
        ]);

        expect(offered).toEqual(["newest", "middle", "oldest"]);
    });

    it("falls back to the update time for sessions that never received a message", async () => {
        const offered = await offeredSessions([
            session({ id: "messaged", lastMessageAt: NOW - 60_000 }),
            session({ id: "untouched", updatedAt: NOW - 1_000 }),
        ]);

        expect(offered).toEqual(["untouched", "messaged"]);
    });

    it("keeps the fifty most recent sessions so the picker stays navigable", async () => {
        const sessions = Array.from({ length: 60 }, (_, index) =>
            session({ id: `session-${index}`, lastMessageAt: NOW - index * 1_000 }),
        );

        const offered = await offeredSessions(sessions);

        expect(offered).toHaveLength(50);
        expect(offered[0]).toBe("session-0");
        expect(offered.at(-1)).toBe("session-49");
        expect(offered).not.toContain("session-50");
    });

    it("says how many sessions were left out when the list is capped", async () => {
        const capped = await pickerSubtitle(
            Array.from({ length: 60 }, (_, index) =>
                session({ id: `session-${index}`, lastMessageAt: NOW - index * 1_000 }),
            ),
        );
        const complete = await pickerSubtitle([session({ id: "only" })]);

        expect(capped).toBe("50 most recent of 60 saved sessions in /workspace.");
        expect(complete).toBe("1 saved session in /workspace.");
    });

    it("resumes the most recent session for --last rather than the first stored one", async () => {
        const client = stubClient([
            session({ id: "older", lastMessageAt: NOW - 60_000 }),
            session({ id: "newer", lastMessageAt: NOW - 1_000 }),
        ]);

        const sessionId = await resolveStartupSessionId({
            client,
            cwd: CWD,
            selection: {
                command: "resume",
                selection: { all: false, last: true },
            },
            startup: stubStartup(() => undefined),
        });

        expect(sessionId).toBe("newer");
    });

    it("leaves out sessions from other directories unless --all is given", async () => {
        const sessions = [
            session({ id: "here" }),
            session({ cwd: "/elsewhere", id: "there", lastMessageAt: NOW - 100 }),
        ];

        expect(await offeredSessions(sessions)).toEqual(["here"]);
        expect(await offeredSessions(sessions, { all: true })).toEqual(["there", "here"]);
    });
});

/** Runs the picker path and reports the sessions it was handed, newest first. */
async function offeredSessions(
    sessions: readonly SessionSummary[],
    options: { all?: boolean } = {},
): Promise<readonly string[]> {
    let offered: readonly string[] = [];
    await resolveStartupSessionId({
        client: stubClient(sessions),
        cwd: CWD,
        selection: {
            command: "resume",
            selection: { all: options.all ?? false, last: false },
        },
        startup: stubStartup((picker) => {
            offered = picker.sessions.map((entry) => entry.id);
            return undefined;
        }),
    });
    return offered;
}

/** Reports the line the picker shows above the sessions it is offering. */
async function pickerSubtitle(sessions: readonly SessionSummary[]): Promise<string> {
    let subtitle = "";
    await resolveStartupSessionId({
        client: stubClient(sessions),
        cwd: CWD,
        selection: { command: "resume", selection: { all: false, last: false } },
        startup: stubStartup((picker) => {
            subtitle = picker.subtitle;
            return undefined;
        }),
    });
    return subtitle;
}

function stubClient(sessions: readonly SessionSummary[]): ProtocolHttpClient {
    return {
        listSessions: async (_options?: number | ListSessionsOptions) => ({ sessions }),
    } as unknown as ProtocolHttpClient;
}

interface PickerInvitation {
    sessions: readonly SessionSummary[];
    subtitle: string;
}

function stubStartup(onSelect: (picker: PickerInvitation) => string | undefined): StartupStatusApp {
    return {
        selectSession: async (options: PickerInvitation) => onSelect(options),
        setStatus: () => {},
    } as unknown as StartupStatusApp;
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        archived: false,
        createdAt: NOW,
        cwd: CWD,
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
        updatedAt: NOW - 10 * 60 * 1_000,
        ...overrides,
    };
}
