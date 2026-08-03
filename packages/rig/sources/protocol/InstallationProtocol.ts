import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const schemaVersionSchema = Type.Integer({ minimum: 0 });
const messageSchema = Type.String({ minLength: 1 });

export const rigDataEpochSchema = Type.String({ maxLength: 128, minLength: 1 });

export const rigInitializedDataSchema = Type.Object(
    {
        epoch: rigDataEpochSchema,
        schemaCompatibility: Type.Union([
            Type.Literal("current"),
            Type.Literal("upgrade_required"),
        ]),
        schemaVersion: schemaVersionSchema,
        status: Type.Literal("initialized"),
    },
    exact,
);
export type RigInitializedData = Static<typeof rigInitializedDataSchema>;

export const rigInstallationDataSchema = Type.Union([
    Type.Object({ status: Type.Literal("absent") }, exact),
    Type.Object({ status: Type.Literal("uninitialized") }, exact),
    rigInitializedDataSchema,
    Type.Object(
        {
            epoch: Type.Optional(rigDataEpochSchema),
            message: messageSchema,
            reason: Type.Literal("newer_schema"),
            schemaVersion: schemaVersionSchema,
            status: Type.Literal("incompatible"),
        },
        exact,
    ),
    Type.Object(
        {
            message: messageSchema,
            reason: Type.Union([
                Type.Literal("busy"),
                Type.Literal("unreadable"),
                Type.Literal("io_error"),
            ]),
            status: Type.Literal("unavailable"),
        },
        exact,
    ),
]);
export type RigInstallationData = Static<typeof rigInstallationDataSchema>;

export const rigCliInstallationInspectionSchema = Type.Object(
    {
        cliProtocolVersion: Type.Integer({ minimum: 1 }),
        cliVersion: Type.String({ minLength: 1 }),
        data: rigInstallationDataSchema,
        formatVersion: Type.Literal(1),
        source: Type.Literal("cli"),
    },
    exact,
);
export type RigCliInstallationInspection = Static<typeof rigCliInstallationInspectionSchema>;

export const rigDaemonInstallationDiscoverySchema = Type.Object(
    {
        daemonProtocolVersion: Type.Integer({ minimum: 1 }),
        daemonVersion: Type.String({ minLength: 1 }),
        data: Type.Object(
            {
                epoch: rigDataEpochSchema,
                schemaCompatibility: Type.Literal("current"),
                schemaVersion: schemaVersionSchema,
                status: Type.Literal("initialized"),
            },
            exact,
        ),
        formatVersion: Type.Literal(1),
        source: Type.Literal("daemon"),
    },
    exact,
);
export type RigDaemonInstallationDiscovery = Static<typeof rigDaemonInstallationDiscoverySchema>;
