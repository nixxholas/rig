import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";

import type { DutyModule } from "../DutyModule.js";
import {
    dutyBindingSchema,
    dutyDeclarationSchema,
    dutyIdSchema,
    dutyRunSchema,
    dutyStatusSchema,
} from "../Duty.js";
import { formatDutyForModel } from "../impl/formatDutyForModel.js";

const dutyResultSchema = Type.Object(
    { duty: dutyBindingSchema, run: dutyRunSchema },
    { additionalProperties: false },
);
const activateDutyInputSchema = Type.Object(
    {
        dutyId: dutyIdSchema,
        trigger: Type.String({ minLength: 1, maxLength: 8_000 }),
    },
    { additionalProperties: false },
);
const setDutyStatusInputSchema = Type.Object(
    { dutyId: dutyIdSchema, status: dutyStatusSchema },
    { additionalProperties: false },
);
const listedDutySchema = Type.Object(
    { duty: dutyBindingSchema, run: Type.Optional(dutyRunSchema) },
    { additionalProperties: false },
);

type ActivateDutyInput = Static<typeof activateDutyInputSchema>;
type SetDutyStatusInput = Static<typeof setDutyStatusInputSchema>;

/** Lifecycle controls exposed to an unbound root Rig session over any ordinary chat transport. */
export function dutyControlTools(duties: DutyModule): readonly AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "issue_duty",
            description:
                "Issue a persistent machine Duty to a dedicated Rig agent. Use a new tenure ID to replace a holder that is no longer performing. The project must be an absolute local path. This changes durable machine state and immediately starts the first run.",
            parameters: dutyDeclarationSchema,
            returnType: dutyResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ dutyId, tenureId, project }) =>
                `issuing Duty "${dutyId}" tenure "${tenureId}" in "${project}" to a dedicated persistent Rig agent`,
            execute: async (ctx, declaration) => await duties.issueManagedDuty(ctx, declaration),
            toLLM: ({ duty, run }) => [
                {
                    type: "text",
                    text: `Issued ${formatDutyForModel(duty, run)}\nThe holder is available as ordinary session ${duty.agentId}.`,
                },
            ],
        }),
        defineAgentTool({
            name: "list_duties",
            description:
                "List every Duty held by this Rig, including stopped historical holders and each live holder's current run.",
            parameters: Type.Object({}, { additionalProperties: false }),
            returnType: Type.Array(listedDutySchema),
            durable: true,
            transactional: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx) =>
                await Promise.all(
                    (await duties.duties(ctx)).map(async (duty) => {
                        const run = await duties.currentRun(ctx, duty.agentId);
                        return { duty, ...(run === undefined ? {} : { run }) };
                    }),
                ),
            toLLM: (entries) => [
                {
                    type: "text",
                    text:
                        entries.length === 0
                            ? "This Rig has no Duties."
                            : entries
                                  .map(({ duty, run }) => formatDutyForModel(duty, run))
                                  .join("\n\n"),
                },
            ],
        }),
        defineAgentTool({
            name: "activate_duty",
            description:
                "Start a run for an active Duty now. If it is already running, return that run instead of duplicating it.",
            parameters: activateDutyInputSchema,
            returnType: dutyRunSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: ActivateDutyInput) => {
                const duty = await requireActiveDuty(duties, ctx, input.dutyId);
                return await duties.activateDuty(ctx, duty.agentId, input.trigger);
            },
            toLLM: (run) => [{ type: "text", text: `Activated Duty run ${run.runId}.` }],
        }),
        defineAgentTool({
            name: "set_duty_status",
            description:
                "Pause, resume, or permanently stop a Duty. A stopped Duty cannot resume; issue a new tenure to replace it.",
            parameters: setDutyStatusInputSchema,
            returnType: dutyBindingSchema,
            durable: true,
            shouldReviewInAutoMode: ({ status }) => status === "stopped",
            describeAutoPermissionAction: ({ dutyId, status }) =>
                `${status === "stopped" ? "permanently stopping" : `setting`} Duty "${dutyId}" to "${status}"`,
            execute: async (ctx, input: SetDutyStatusInput) => {
                const duty = await requireActiveDuty(duties, ctx, input.dutyId);
                return await duties.changeDutyStatus(ctx, duty.agentId, input.status);
            },
            toLLM: (duty) => [{ type: "text", text: `Duty ${duty.dutyId} is now ${duty.status}.` }],
        }),
    ];
}

async function requireActiveDuty(
    duties: DutyModule,
    ctx: Parameters<DutyModule["duty"]>[0],
    dutyId: string,
) {
    const duty = await duties.activeDuty(ctx, dutyId);
    if (duty === undefined) throw new Error(`Duty "${dutyId}" has no live holder.`);
    return duty;
}

export { activateDutyInputSchema, setDutyStatusInputSchema };
