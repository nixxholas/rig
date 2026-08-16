import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_APPLET_LIST_SIZE,
    MAX_APPLET_VERSIONS,
    appletAssetSchema,
    appletChangeDescriptionSchema,
    appletCurrentResultSchema,
    appletDescriptionSchema,
    defaultAppletAllowedScopes,
    appletIconThumbhashSchema,
    appletIconUrlSchema,
    appletImportInputSchema,
    appletListPageSchema,
    appletListQuerySchema,
    appletNameSchema,
    appletPurposeSchema,
    appletRefSchema,
    appletSchema,
    appletUpdateInputSchema,
    appletVersionNumberSchema,
    appletVersionSchema,
    type Applet,
    type AppletAsset,
    type AppletCurrentResult,
    type AppletListPage,
} from "./Applet.js";

/**
 * Context is deliberately opaque to this package, but an object boundary is
 * still useful in the runtime contract.  `Unsafe<Context>` preserves the
 * published Context type for structural implementations without accepting
 * arbitrary primitive values.
 */
const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));

const mutationIdentityFields = {
    name: appletNameSchema,
    operationId: appletRefSchema,
    /** The version this operation requested; zero is used by remove. */
    targetVersion: Type.Integer({ minimum: 0, maximum: MAX_APPLET_VERSIONS }),
    /** The current version after this operation; zero means removed. */
    currentVersion: Type.Integer({ minimum: 0, maximum: MAX_APPLET_VERSIONS }),
    changed: Type.Boolean(),
};

export const appletCatalogOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("revert"),
    Type.Literal("remove"),
]);

const appletCatalogMutationAppletFields = {
    ...mutationIdentityFields,
    applet: appletSchema,
};

export const appletCatalogCreateResultSchema = Type.Object(
    {
        ...appletCatalogMutationAppletFields,
        operation: Type.Literal("create"),
    },
    { additionalProperties: false },
);

export const appletCatalogUpdateResultSchema = Type.Object(
    {
        ...appletCatalogMutationAppletFields,
        operation: Type.Literal("update"),
    },
    { additionalProperties: false },
);

export const appletCatalogRevertResultSchema = Type.Object(
    {
        ...appletCatalogMutationAppletFields,
        operation: Type.Literal("revert"),
    },
    { additionalProperties: false },
);

export const appletCatalogRemoveResultSchema = Type.Object(
    {
        ...mutationIdentityFields,
        operation: Type.Literal("remove"),
        removed: Type.Boolean(),
        applet: Type.Optional(appletSchema),
    },
    { additionalProperties: false },
);

/**
 * Mutation results carry the requested identity and target explicitly.  A
 * schema-valid applet alone cannot tell a module whether a broken adapter
 * applied a different operation, so every host mutation returns this envelope.
 */
export const appletCatalogMutationResultSchema = Type.Union([
    appletCatalogCreateResultSchema,
    appletCatalogUpdateResultSchema,
    appletCatalogRevertResultSchema,
    appletCatalogRemoveResultSchema,
]);

/**
 * Icon metadata the module derives while it installs the source. The module
 * owns the filesystem and generates the icon files itself, so it hands the
 * catalog only the durable metadata to persist, never a path.
 */
/** The catalog input for the initial metadata row and source version. */
const appletCatalogCreateFields = {
    name: appletImportInputSchema.properties.name,
    description: appletDescriptionSchema,
    purpose: appletPurposeSchema,
    authorSessionId: appletImportInputSchema.properties.authorSessionId,
    allowedScopes: Type.Optional(appletImportInputSchema.properties.allowedScopes),
    sourceDescription: Type.Optional(appletImportInputSchema.properties.sourceDescription),
    initialVersion: Type.Object(
        {
            version: Type.Literal(1),
            changeDescription: Type.Literal("Initial import"),
            createdAt: appletVersionSchema.properties.createdAt,
            operationId: appletRefSchema,
        },
        { additionalProperties: false },
    ),
    operationId: appletRefSchema,
};

export const appletCatalogCreateInputSchema = Type.Union([
    Type.Object(
        {
            ...appletCatalogCreateFields,
            iconThumbhash: appletIconThumbhashSchema,
            iconUrl: appletIconUrlSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...appletCatalogCreateFields,
            iconThumbhash: Type.Optional(Type.Undefined()),
            iconUrl: Type.Optional(Type.Undefined()),
        },
        { additionalProperties: false },
    ),
]);

/** The catalog input for one newly imported version and optional metadata changes. */
export const appletCatalogUpdateInputSchema = Type.Object(
    {
        changeDescription: appletChangeDescriptionSchema,
        createdAt: appletVersionSchema.properties.createdAt,
        allowedScopes: Type.Optional(appletUpdateInputSchema.properties.allowedScopes),
        description: Type.Optional(appletUpdateInputSchema.properties.description),
        purpose: Type.Optional(appletUpdateInputSchema.properties.purpose),
        sourceDescription: Type.Optional(appletUpdateInputSchema.properties.sourceDescription),
        operationId: appletRefSchema,
    },
    { additionalProperties: false },
);

export const appletCatalogRevertInputSchema = Type.Object(
    {
        version: appletVersionNumberSchema,
        operationId: appletRefSchema,
    },
    { additionalProperties: false },
);

const catalogListQuerySchema = Type.Object(
    {
        limit: Type.Integer({ minimum: 1, maximum: MAX_APPLET_LIST_SIZE }),
        cursor: Type.Optional(appletListQuerySchema.properties.cursor),
    },
    { additionalProperties: false },
);

/** Module-owned applet database surface. */
export const appletCatalogSchema = Type.Object(
    {
        list: Type.Function(
            [opaqueContextSchema, catalogListQuerySchema],
            Type.Promise(appletListPageSchema),
        ),
        get: Type.Function(
            [opaqueContextSchema, appletNameSchema],
            Type.Promise(Type.Union([appletSchema, Type.Undefined()])),
        ),
        lock: Type.Function([opaqueContextSchema, appletNameSchema], Type.Promise(appletSchema)),
        create: Type.Function(
            [opaqueContextSchema, appletCatalogCreateInputSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        update: Type.Function(
            [opaqueContextSchema, appletNameSchema, appletCatalogUpdateInputSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        revert: Type.Function(
            [opaqueContextSchema, appletNameSchema, appletCatalogRevertInputSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        remove: Type.Function(
            [opaqueContextSchema, appletNameSchema, appletRefSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        current: Type.Function(
            [opaqueContextSchema, appletNameSchema],
            Type.Promise(appletCurrentResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type AppletCatalog = Static<typeof appletCatalogSchema>;
export type AppletCatalogSchema = AppletCatalog;
export type AppletCatalogCreateInput = Static<typeof appletCatalogCreateInputSchema>;
export type AppletCatalogUpdateInput = Static<typeof appletCatalogUpdateInputSchema>;
export type AppletCatalogRevertInput = Static<typeof appletCatalogRevertInputSchema>;
export type AppletCatalogMutationResult = Static<typeof appletCatalogMutationResultSchema>;
export type AppletCatalogOperation = Static<typeof appletCatalogOperationSchema>;
export type AppletCatalogCreateResult = Static<typeof appletCatalogCreateResultSchema>;
export type AppletCatalogUpdateResult = Static<typeof appletCatalogUpdateResultSchema>;
export type AppletCatalogRevertResult = Static<typeof appletCatalogRevertResultSchema>;
export type AppletCatalogRemoveResult = Static<typeof appletCatalogRemoveResultSchema>;

export function assertApplet(value: unknown): asserts value is Applet {
    if (!Value.Check(appletSchema, value)) {
        throw new Error("Applet catalog returned an invalid applet.");
    }
    const applet = value as Applet;
    const seenVersions = new Set<number>();
    const seenOperations = new Set<string>();
    let previousCreatedAt = applet.createdAt;
    if (applet.versions[0]?.version !== 1) {
        throw new Error("Applet versions must start at version 1.");
    }
    for (const [index, version] of applet.versions.entries()) {
        if (version.version !== index + 1 || seenVersions.has(version.version)) {
            throw new Error("Applet versions must be contiguous and unique.");
        }
        seenVersions.add(version.version);
        if (version.createdAt < applet.createdAt || version.createdAt > applet.updatedAt) {
            throw new Error("Applet version timestamps are outside the applet lifetime.");
        }
        if (version.createdAt < previousCreatedAt) {
            throw new Error("Applet version timestamps must be ordered.");
        }
        previousCreatedAt = version.createdAt;
        if (seenOperations.has(version.operationId)) {
            throw new Error("Applet version operation identities must be unique.");
        }
        seenOperations.add(version.operationId);
    }
    if (!seenVersions.has(applet.currentVersion)) {
        throw new Error("Applet currentVersion does not identify a stored version.");
    }
    if (applet.updatedAt < applet.createdAt) {
        throw new Error("Applet updatedAt precedes createdAt.");
    }
}
export function assertAppletPage(value: unknown): asserts value is AppletListPage {
    if (!Value.Check(appletListPageSchema, value)) {
        throw new Error("Applet catalog returned an invalid applet page.");
    }
    const page = value as AppletListPage;
    const names = new Set<string>();
    for (const applet of page.applets) {
        assertApplet(applet);
        if (names.has(applet.name)) {
            throw new Error("Applet page contains duplicate names.");
        }
        names.add(applet.name);
    }
    if (page.hasMore && page.applets.length === 0) {
        throw new Error("A non-terminal applet page must make item progress.");
    }
}

export function assertAppletAsset(value: unknown): asserts value is AppletAsset {
    if (!Value.Check(appletAssetSchema, value)) {
        throw new Error("Applet asset reader returned an invalid asset.");
    }
}

export function assertAppletCurrent(value: unknown): asserts value is AppletCurrentResult {
    if (!Value.Check(appletCurrentResultSchema, value)) {
        throw new Error("Applet catalog returned an invalid current version.");
    }
}

export function assertAppletMutation(value: unknown): asserts value is AppletCatalogMutationResult {
    if (!Value.Check(appletCatalogMutationResultSchema, value)) {
        throw new Error("Applet catalog returned an invalid mutation result.");
    }
    const mutation = value as AppletCatalogMutationResult;
    if (mutation.operation !== "remove") {
        assertApplet(mutation.applet);
        if (mutation.applet.name !== mutation.name) {
            throw new Error("Applet mutation returned the wrong applet name.");
        }
        if (
            !mutation.applet.versions.some((version) => version.version === mutation.targetVersion)
        ) {
            throw new Error("Applet mutation target version is not present.");
        }
    } else if (mutation.applet !== undefined) {
        assertApplet(mutation.applet);
    }
    if (
        mutation.operation !== "remove" &&
        mutation.currentVersion !== mutation.applet.currentVersion
    ) {
        throw new Error("Applet mutation current version does not match the applet.");
    }
}
