import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("aborting an active session stops its background processes", () => {
    it("terminates a yielded command while the model is still running", async () => {
        const command =
            "trap 'printf stopped > background-process-state.txt; exit 143' TERM INT; printf running > background-process-state.txt; printf 'BACKGROUND_PROCESS_STARTED\\n'; while :; do sleep 1; done";
        const gym = await createGym({
            mode: "docker",
            cols: 92,
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: { cmd: command, yield_time_ms: 250 },
                                id: "start-background-process",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (callIndex === 1) {
                    expect(request.context.messages.at(-1)).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    return {
                        content: [
                            {
                                text: "THIS_ACTIVE_RESPONSE_SHOULD_BE_ABORTED",
                                type: "text",
                            },
                        ],
                        delayMs: 30_000,
                    };
                }

                expect(callIndex).toBe(2);
                expect(request.context.messages.at(-1)).toMatchObject({ role: "user" });
                return {
                    content: [{ text: "SESSION_RECOVERED_AFTER_ABORT", type: "text" }],
                };
            },
            rows: 24,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        submit(gym, "Start the background process, then keep working.");
        const active = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("1 background terminal running") &&
                snapshot.text.includes("esc to interrupt") &&
                snapshot.scroll.atBottom,
            "an active session with a yielded process",
            30_000,
        );
        expect(active.text).not.toContain("THIS_ACTIVE_RESPONSE_SHOULD_BE_ABORTED");
        await expect(gym.readFile("background-process-state.txt")).resolves.toBe("running");

        submit(gym, "/abort");
        const stopped = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                !snapshot.text.includes("background terminal running") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "the active session and its background process to stop",
            30_000,
        );
        expect(stopped.text).not.toContain("THIS_ACTIVE_RESPONSE_SHOULD_BE_ABORTED");
        await expect
            .poll(() => gym.readFile("background-process-state.txt"), { timeout: 10_000 })
            .toBe("stopped");
        assertHealthy(stopped, baseline);

        submit(gym, "Confirm the session still works after abort.");
        const recovered = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("SESSION_RECOVERED_AFTER_ABORT") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "a healthy turn after aborting the session",
            30_000,
        );
        assertHealthy(recovered, baseline);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function assertHealthy(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    baseline: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>["scroll"],
): void {
    expect(snapshot.rows).toHaveLength(24);
    expect(snapshot.scroll.visibleRows).toBe(24);
    expect(snapshot.scroll.atBottom).toBe(true);
    expect(snapshot.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
    expect(snapshot.text).toContain("gym off · /workspace");
    expect(snapshot.text).not.toContain("�");
}
