import { Type, type Static } from "@sinclair/typebox";

const rigInstallationDataSchema = Type.Union([
    Type.Object({ status: Type.Literal("absent") }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("uninitialized") }, { additionalProperties: false }),
    Type.Object(
        {
            epoch: Type.String({ maxLength: 128, minLength: 1 }),
            status: Type.Literal("initialized"),
        },
        { additionalProperties: false },
    ),
]);

/**
 * A compact, one-shot description of the Rig installation behind an endpoint.
 *
 * This schema lives in rig-connect rather than importing the daemon's one so
 * browser consumers carry no daemon code. Protocol conformance tests compare
 * the two declarations at build time.
 */
export const rigInstallationInspectionSchema = Type.Object(
    {
        data: rigInstallationDataSchema,
        formatVersion: Type.Literal(1),
        protocolVersion: Type.Integer({ minimum: 1 }),
        rigVersion: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

export type RigInstallationInspection = Static<typeof rigInstallationInspectionSchema>;
