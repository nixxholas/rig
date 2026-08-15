import { Type, type Static } from "@sinclair/typebox";

import { workletPermissionsSchema } from "../protocol/WorkletProtocol.js";

/** The manifest sits at the root of the imported source folder, beside the entry point. */
export const WORKLET_MANIFEST_FILE_NAME = "worklet.json";

/** A manifest is a handful of fields, so an enormous one is a source folder to refuse. */
export const WORKLET_MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * The manifest's description is a label, not an explanation.
 *
 * It sits in lists beside the worklet's name, so it stays to one line. Everything a person wants
 * to know goes in the worklet's own `README.md`, which has room for it.
 */
export const WORKLET_DESCRIPTION_MAX_LENGTH = 120;

/**
 * What a worklet declares about itself.
 *
 * Every field is required, including the permissions. A worklet that wants nothing beyond its own
 * `Data` folder still writes that down, because the point of the manifest is that what a worklet
 * may touch is stated by the code being installed rather than inferred from its silence.
 */
export const workletManifestSchema = Type.Object(
    {
        name: Type.String({
            description: 'Human-readable kebab-case worklet name, such as "github-watch".',
            minLength: 1,
        }),
        description: Type.String({
            description: "One line saying what the worklet does.",
            maxLength: WORKLET_DESCRIPTION_MAX_LENGTH,
            minLength: 1,
        }),
        permissions: workletPermissionsSchema,
    },
    { additionalProperties: false },
);

export type WorkletManifest = Static<typeof workletManifestSchema>;
