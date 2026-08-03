import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

export const rigDataEpochSchema = Type.String({ maxLength: 128, minLength: 1 });

export const rigInstallationDataSchema = Type.Union([
    Type.Object({ status: Type.Literal("absent") }, exact),
    Type.Object({ status: Type.Literal("uninitialized") }, exact),
    Type.Object(
        {
            epoch: rigDataEpochSchema,
            status: Type.Literal("initialized"),
        },
        exact,
    ),
]);
export type RigInstallationData = Static<typeof rigInstallationDataSchema>;

export const rigInstallationInspectionSchema = Type.Object(
    {
        data: rigInstallationDataSchema,
        formatVersion: Type.Literal(1),
        protocolVersion: Type.Integer({ minimum: 1 }),
        rigVersion: Type.String({ minLength: 1 }),
    },
    exact,
);
export type RigInstallationInspection = Static<typeof rigInstallationInspectionSchema>;
