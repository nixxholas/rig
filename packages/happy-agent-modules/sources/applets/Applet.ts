import { Type, type Static } from "@sinclair/typebox";

/**
 * Applet data is deliberately independent from Rig's protocol and slot types. Hosts may use
 * paths, database IDs, URLs, and scope/action references with whatever meaning they need; this
 * module only validates their bounded representation.
 */

export const MAX_APPLET_VERSIONS = 100;
export const MAX_APPLET_LIST_SIZE = 100;
/**
 * Cursor values are opaque to the module, but must still fit beside a
 * maximum-length applet identity in the minimum model-output budget.
 */
export const MAX_APPLET_CURSOR_LENGTH = 100;
export const MAX_APPLET_SOURCE_FILES = 10_000;
export const MAX_APPLET_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_APPLET_SOURCE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_APPLET_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_APPLET_ASSET_OUTPUT_CHARACTERS = 100_000;

export const appletNameSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

export const appletDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: 2_000,
});

export const appletPurposeSchema = Type.String({
    minLength: 1,
    maxLength: 2_000,
});

/** A caller-owned opaque identity, such as an agent/session or an applet action. */
export const appletRefSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/** An absolute source folder path on this machine. The module verifies and copies it. */
export const appletSourcePathSchema = Type.String({
    minLength: 1,
    maxLength: 4_096,
    pattern: "^[^\\u0000]+$",
});

/** A relative path within an installed applet version, resolved and bounds-checked when read. */
export const appletAssetPathSchema = Type.String({
    minLength: 1,
    maxLength: 2_048,
    pattern: "^[^\\u0000]+$",
});

export const appletScopeRefSchema = appletRefSchema;
export const appletActionRefSchema = appletRefSchema;

export const appletVersionNumberSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_APPLET_VERSIONS,
});

export const appletTimestampSchema = Type.Integer({
    minimum: 0,
});

export const appletChangeDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: 2_000,
});

export const appletVersionSchema = Type.Object(
    {
        version: appletVersionNumberSchema,
        changeDescription: appletChangeDescriptionSchema,
        createdAt: appletTimestampSchema,
        /** Stable identity of the tool call or direct host operation that created this version. */
        operationId: appletRefSchema,
    },
    { additionalProperties: false },
);

/**
 * The host catalog's safe applet metadata. Optional icon/HTTP fields preserve compatibility with
 * hosts that expose them, while keeping their paths and serving policy outside this package.
 */
export const appletSchema = Type.Object(
    {
        name: appletNameSchema,
        description: appletDescriptionSchema,
        purpose: appletPurposeSchema,
        authorSessionId: appletRefSchema,
        allowedScopes: Type.Array(appletScopeRefSchema, {
            minItems: 1,
            maxItems: 32,
            uniqueItems: true,
        }),
        sourceDescription: Type.Optional(Type.String({ maxLength: 2_000 })),
        iconThumbhash: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        iconUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        currentVersion: appletVersionNumberSchema,
        versions: Type.Array(appletVersionSchema, {
            minItems: 1,
            maxItems: MAX_APPLET_VERSIONS,
        }),
        createdAt: appletTimestampSchema,
        updatedAt: appletTimestampSchema,
    },
    { additionalProperties: false },
);

/**
 * Public creation input. `path` is an absolute source folder and `iconPath` an optional absolute
 * PNG icon; the module verifies both and installs the source into the applets directory itself.
 */
export const appletImportInputSchema = Type.Object(
    {
        name: appletNameSchema,
        description: appletDescriptionSchema,
        purpose: appletPurposeSchema,
        authorSessionId: appletRefSchema,
        path: appletSourcePathSchema,
        iconPath: Type.Optional(appletSourcePathSchema),
        allowedScopes: Type.Optional(
            Type.Array(appletScopeRefSchema, {
                minItems: 1,
                maxItems: 32,
                uniqueItems: true,
            }),
        ),
        sourceDescription: Type.Optional(Type.String({ maxLength: 2_000 })),
        /** Optional history identity for direct host calls; tools use their supplied call ID. */
        operationId: Type.Optional(appletRefSchema),
    },
    { additionalProperties: false },
);

/** A descriptive alias for hosts that call the first import “create”. */
export const appletCreateInputSchema = appletImportInputSchema;

export const appletUpdateInputSchema = Type.Object(
    {
        path: appletSourcePathSchema,
        changeDescription: appletChangeDescriptionSchema,
        allowedScopes: Type.Optional(
            Type.Array(appletScopeRefSchema, {
                minItems: 1,
                maxItems: 32,
                uniqueItems: true,
            }),
        ),
        description: Type.Optional(appletDescriptionSchema),
        purpose: Type.Optional(appletPurposeSchema),
        sourceDescription: Type.Optional(Type.String({ maxLength: 2_000 })),
        iconPath: Type.Optional(appletSourcePathSchema),
        operationId: Type.Optional(appletRefSchema),
    },
    { additionalProperties: false },
);

export const appletRevertInputSchema = Type.Object(
    {
        version: appletVersionNumberSchema,
        operationId: Type.Optional(appletRefSchema),
    },
    { additionalProperties: false },
);

export const appletListQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_APPLET_LIST_SIZE })),
        /** Cursors are host-owned positions and are never parsed by the module. */
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_APPLET_CURSOR_LENGTH })),
    },
    { additionalProperties: false },
);

const appletPageFields = {
    applets: Type.Array(appletSchema, { maxItems: MAX_APPLET_LIST_SIZE }),
    limit: Type.Integer({ minimum: 1, maximum: MAX_APPLET_LIST_SIZE }),
};

/**
 * A page is cursor-capable by construction.  A non-terminal page must carry a
 * cursor, and a terminal page must not pretend that a cursor exists.
 */
export const appletListPageSchema = Type.Union([
    Type.Object(
        {
            ...appletPageFields,
            hasMore: Type.Literal(false),
            nextCursor: Type.Optional(
                Type.String({ minLength: 1, maxLength: MAX_APPLET_CURSOR_LENGTH }),
            ),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...appletPageFields,
            hasMore: Type.Literal(true),
            nextCursor: Type.String({ minLength: 1, maxLength: MAX_APPLET_CURSOR_LENGTH }),
        },
        { additionalProperties: false },
    ),
]);

export const appletListSchema = Type.Array(appletSchema, {
    maxItems: MAX_APPLET_LIST_SIZE,
});

export const appletAssetReadInputSchema = Type.Object(
    {
        name: appletNameSchema,
        path: appletAssetPathSchema,
        version: Type.Optional(appletVersionNumberSchema),
    },
    { additionalProperties: false },
);

export const appletAssetEncodingSchema = Type.Union([Type.Literal("utf8"), Type.Literal("base64")]);

/**
 * Asset content is represented as text or base64 so it can cross a provider/HTTP boundary without
 * exposing a Node Buffer. The host reader receives a byte cap and must enforce it before loading.
 */
export const appletAssetSchema = Type.Object(
    {
        name: appletNameSchema,
        version: appletVersionNumberSchema,
        path: appletAssetPathSchema,
        contentType: Type.String({ minLength: 1, maxLength: 256 }),
        encoding: appletAssetEncodingSchema,
        // A UTF-8 string can use one byte per character while base64 uses four
        // characters for every three bytes.  The module performs the exact
        // encoded-byte check after the shape check, but this cap keeps malformed
        // adapters from returning an unbounded string first.
        content: Type.String({
            maxLength: Math.ceil((MAX_APPLET_ASSET_BYTES * 4) / 3) + 4,
        }),
        byteLength: Type.Integer({ minimum: 0, maximum: MAX_APPLET_ASSET_BYTES }),
    },
    { additionalProperties: false },
);

export const appletAssetResultSchema = Type.Union([
    appletAssetSchema,
    Type.Undefined(),
    Type.Null(),
]);

/**
 * Tool inputs intentionally omit both the author and operation identity. The
 * module derives the author from the AgentModuleScope/host callback, while
 * each tool supplies the stable call ID it receives from Agent Base.
 */
export const appletToolImportInputSchema = Type.Omit(appletImportInputSchema, [
    "authorSessionId",
    "operationId",
]);
export const appletToolUpdateInputSchema = Type.Omit(appletUpdateInputSchema, ["operationId"]);
export const appletToolRevertInputSchema = Type.Omit(appletRevertInputSchema, ["operationId"]);

export const appletCurrentResultSchema = Type.Union([appletVersionSchema, Type.Undefined()]);

export type AppletName = Static<typeof appletNameSchema>;
export type AppletDescription = Static<typeof appletDescriptionSchema>;
export type AppletPurpose = Static<typeof appletPurposeSchema>;
export type AppletRef = Static<typeof appletRefSchema>;
export type AppletSourcePath = Static<typeof appletSourcePathSchema>;
export type AppletAssetPath = Static<typeof appletAssetPathSchema>;
export type AppletScopeRef = Static<typeof appletScopeRefSchema>;
export type AppletActionRef = Static<typeof appletActionRefSchema>;
export type AppletVersionNumber = Static<typeof appletVersionNumberSchema>;
export type AppletTimestamp = Static<typeof appletTimestampSchema>;
export type AppletChangeDescription = Static<typeof appletChangeDescriptionSchema>;
export type AppletAssetEncoding = Static<typeof appletAssetEncodingSchema>;
export type AppletVersion = Static<typeof appletVersionSchema>;
export type Applet = Static<typeof appletSchema>;
export type AppletImportInput = Static<typeof appletImportInputSchema>;
export type AppletCreateInput = Static<typeof appletCreateInputSchema>;
export type AppletUpdateInput = Static<typeof appletUpdateInputSchema>;
export type AppletRevertInput = Static<typeof appletRevertInputSchema>;
export type AppletListQuery = Static<typeof appletListQuerySchema>;
export type AppletListPage = Static<typeof appletListPageSchema>;
export type AppletCursor = Static<typeof appletListQuerySchema.properties.cursor>;
export type AppletAssetReadInput = Static<typeof appletAssetReadInputSchema>;
export type AppletAsset = Static<typeof appletAssetSchema>;
export type AppletCurrentResult = Static<typeof appletCurrentResultSchema>;
export type AppletToolImportInput = Static<typeof appletToolImportInputSchema>;
export type AppletToolUpdateInput = Static<typeof appletToolUpdateInputSchema>;
export type AppletToolRevertInput = Static<typeof appletToolRevertInputSchema>;
