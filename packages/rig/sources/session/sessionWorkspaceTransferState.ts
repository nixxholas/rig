import { Type, type Static } from "@sinclair/typebox";

export const sessionWorkspaceTransferStateSchema = Type.Union([
    Type.Object({ status: Type.Literal("idle") }, { additionalProperties: false }),
    Type.Object(
        {
            status: Type.Literal("scheduled"),
            targetWorkspaceId: Type.String(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: Type.Literal("transferring"),
            targetWorkspaceId: Type.String(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: Type.Literal("succeeded"),
            targetWorkspaceId: Type.String(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            errorMessage: Type.String(),
            status: Type.Literal("failed"),
            target: Type.Union([
                Type.Literal("not_touched"),
                Type.Literal("restored"),
                Type.Literal("restore_failed"),
            ]),
            targetWorkspaceId: Type.String(),
        },
        { additionalProperties: false },
    ),
]);

export type SessionWorkspaceTransferState = Static<typeof sessionWorkspaceTransferStateSchema>;
