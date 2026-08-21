import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { DutyModule } from "../duty/DutyModule.js";
import {
    dutyAllowedToolsSchema,
    dutyAgentIdSchema,
    dutyCharterSchema,
    dutyIdSchema,
    dutyTriggerSchema,
    type IssueDutyInput,
} from "../duty/Duty.js";
import { agentPermissionModeSchema } from "@slopus/happy-agent-base";

import type { HappyMachineRpcHandler } from "./HappyMachineClient.js";

const issueDutyRequestSchema = Type.Object(
    {
        agentId: dutyAgentIdSchema,
        allowedTools: dutyAllowedToolsSchema,
        charter: dutyCharterSchema,
        confirmation: Type.Literal("issue-duty"),
        dutyId: dutyIdSchema,
        permissionCeiling: agentPermissionModeSchema,
        tenureId: dutyIdSchema,
        trigger: dutyTriggerSchema,
    },
    { additionalProperties: false },
);

const dutyAgentRequestSchema = Type.Object(
    {
        agentId: dutyAgentIdSchema,
    },
    { additionalProperties: false },
);

const activateDutyRequestSchema = Type.Object(
    {
        agentId: dutyAgentIdSchema,
        trigger: Type.String({ minLength: 1, maxLength: 8_000 }),
    },
    { additionalProperties: false },
);

/**
 * Rig-owned Duty controls that travel through Happy's existing generic machine relay.
 *
 * They are deliberately additional methods. Older Happy servers relay them unchanged and older
 * clients never call them, leaving the deployed session protocol exactly as it is today.
 */
export function createHappyDutyMachineRpcHandlers(
    duties: DutyModule,
): readonly HappyMachineRpcHandler[] {
    return [
        {
            method: "duty-issue",
            handle: async (ctx, params) => {
                if (!Value.Check(issueDutyRequestSchema, params)) {
                    throw new Error(
                        "Duty issue request is invalid or lacks explicit confirmation.",
                    );
                }
                const { agentId, confirmation: _confirmation, ...input } = params;
                return await duties.issueDuty(ctx, agentId, input as IssueDutyInput);
            },
        },
        {
            method: "duty-activate",
            handle: async (ctx, params) => {
                if (!Value.Check(activateDutyRequestSchema, params)) {
                    throw new Error("Duty activation request is invalid.");
                }
                return { run: await duties.activateDuty(ctx, params.agentId, params.trigger) };
            },
        },
        {
            method: "duty-status",
            handle: async (ctx, params) => {
                if (!Value.Check(dutyAgentRequestSchema, params)) {
                    throw new Error("Duty status request is invalid.");
                }
                return {
                    duty: await duties.duty(ctx, params.agentId),
                    run: await duties.currentRun(ctx, params.agentId),
                };
            },
        },
        ...(["pause", "resume", "stop"] as const).map(
            (action): HappyMachineRpcHandler => ({
                method: `duty-${action}`,
                handle: async (ctx, params) => {
                    if (!Value.Check(dutyAgentRequestSchema, params)) {
                        throw new Error(`Duty ${action} request is invalid.`);
                    }
                    const status =
                        action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
                    return { duty: await duties.changeDutyStatus(ctx, params.agentId, status) };
                },
            }),
        ),
    ];
}
