import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * A review is a real turn of the real reviewer agent, served by the same scripted model, so a
 * scenario recognizes it by the request the reviewer is sent rather than by counting turns.
 */
function isReview(request: GymInferenceRequest): boolean {
    return JSON.stringify(request.messages).includes("<proposed_action>");
}

/** The verdict the guardian writes, in the tagged form the module parses. */
function verdict(options: {
    readonly authorization: string;
    readonly outcome: string;
    readonly rationale: string;
    readonly risk: string;
}): GymTurn {
    return {
        content: [
            {
                text: [
                    "<review>",
                    `<risk_level>${options.risk}</risk_level>`,
                    `<user_authorization>${options.authorization}</user_authorization>`,
                    `<outcome>${options.outcome}</outcome>`,
                    `<rationale>${options.rationale}</rationale>`,
                    "</review>",
                ].join("\n"),
                type: "text",
            },
        ],
    };
}

/** Asking to leave the sandbox is what makes a command reviewable, so both calls say so. */
function escalatedWrite(callId: string): GymTurn {
    return {
        content: [
            {
                arguments: {
                    cmd: "echo reviewed > AGENTS.md && echo written",
                    justification: "The user asked me to rewrite the project rules.",
                    sandbox_permissions: "require_escalated",
                },
                callId,
                name: "exec_command",
                type: "tool_call",
            },
        ],
    };
}

async function permissionEvents(gym: AgentGym): Promise<readonly Record<string, unknown>[]> {
    const events = await gym.events();
    return events
        .filter((event) => event.type === "permission.event")
        .map((event) => event.payload as Record<string, unknown>);
}

async function permissionReviews(gym: AgentGym): Promise<readonly Record<string, unknown>[]> {
    const events = await gym.sessionEvents();
    return events
        .filter((event) => event.type === "permission_review")
        .map((event) => (event.data as { readonly event: Record<string, unknown> }).event);
}

describe("the automatic reviewer decides an Auto command that asks to leave the sandbox", () => {
    it("lets the approved command run elevated, and sandboxes the very next one again", async () => {
        let turn = 0;
        const gym = await createAgentGym({
            files: { "AGENTS.md": "the project rules\n" },
            inference(request) {
                if (isReview(request)) {
                    return verdict({
                        authorization: "high",
                        outcome: "allow",
                        rationale: "The user asked for this rewrite in the message above.",
                        risk: "low",
                    });
                }
                turn += 1;
                if (turn === 1) return escalatedWrite("escalated-call");
                if (turn === 2) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "echo again > AGENTS.md && echo written" },
                                callId: "sandboxed-call",
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return { content: [{ text: "I rewrote the rules once.", type: "text" }] };
            },
            timeoutMs: 30_000,
        });
        running.add(gym);

        await gym.send("Rewrite the project rules.", { permissionMode: "auto" });

        // The approved command really ran with the sandbox lifted: it changed a file that Auto's
        // own boundary protects.
        await expect(gym.readFile("AGENTS.md")).resolves.toBe("reviewed\n");

        // The elevation belonged to that one call. The same write, unescalated, is refused by the
        // boundary immediately afterwards, and never reaches a reviewer.
        const results = gym.inference.toolResults();
        expect(results[0]?.text).toContain("written");
        expect(results[1]?.text).toContain("Permission boundary blocks modifying the denied path");

        const reviewed = (await permissionEvents(gym)).filter(
            (event) => event.type === "permission_action_reviewed",
        );
        expect(reviewed).toEqual([
            expect.objectContaining({
                action: expect.stringContaining("echo reviewed > AGENTS.md"),
                callId: "escalated-call",
                elevated: true,
                reason: "The user asked for this rewrite in the message above.",
                risk: "low",
                tool: "exec_command",
                userAuthorization: "high",
            }),
        ]);

        // A client sees one review annotation, addressed to the call that was held for it. The
        // sandboxed call was allowed outright and produces no row at all.
        expect(await permissionReviews(gym)).toEqual([
            expect.objectContaining({
                decision: "allow",
                reason: "The user asked for this rewrite in the message above.",
                toolCallId: "escalated-call",
            }),
        ]);

        // The reviewer was really asked, and it was shown the command it was judging.
        const asked = gym.inference.requests.filter(isReview);
        expect(asked).toHaveLength(1);
        expect(JSON.stringify(asked[0]?.messages)).toContain("echo reviewed > AGENTS.md");
        expect(gym.errors).toEqual([]);
    });

    it("refuses the denied command, leaves the file alone and tells the model not to work around it", async () => {
        let turn = 0;
        const gym = await createAgentGym({
            files: { "AGENTS.md": "the project rules\n" },
            inference(request) {
                if (isReview(request)) {
                    return verdict({
                        authorization: "low",
                        outcome: "deny",
                        rationale: "Nobody asked for the project rules to be rewritten.",
                        risk: "high",
                    });
                }
                turn += 1;
                return turn === 1
                    ? escalatedWrite("refused-call")
                    : { content: [{ text: "I was refused, so I stopped.", type: "text" }] };
            },
            timeoutMs: 30_000,
        });
        running.add(gym);

        await gym.send("Rewrite the project rules.", { permissionMode: "auto" });

        await expect(gym.readFile("AGENTS.md")).resolves.toBe("the project rules\n");

        const refusal = gym.inference.toolResults()[0]?.text ?? "";
        expect(refusal).toContain("Automatic permission review refused");
        expect(refusal).toContain("Nobody asked for the project rules to be rewritten.");
        expect(refusal).toContain("Do not pursue the same outcome by another route");
        // A command that ran would have reported its wall time and exit code; this one never ran.
        expect(refusal).not.toContain("Wall time");

        expect(
            (await permissionEvents(gym)).filter(
                (event) => event.type === "permission_action_denied",
            ),
        ).toEqual([
            expect.objectContaining({
                callId: "refused-call",
                reason: "Nobody asked for the project rules to be rewritten.",
                risk: "high",
                tool: "exec_command",
                userAuthorization: "low",
            }),
        ]);

        expect(await permissionReviews(gym)).toEqual([
            expect.objectContaining({
                decision: "deny",
                risk: "high",
                toolCallId: "refused-call",
                userAuthorization: "low",
            }),
        ]);

        // One refusal does not end the turn: the agent answered afterwards and the run settled.
        expect(JSON.stringify(await gym.sessionEvents())).toContain("I was refused, so I stopped.");
        expect(gym.errors).toEqual([]);
    });
});
