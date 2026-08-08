import {
    createIconArtifacts,
    IMPORTED_ICON_MAX_BYTES,
    IMPORTED_ICON_SIZE,
    type IconArtifacts,
} from "../imports/createIconArtifacts.js";

export const WORKLET_ICON_SIZE = IMPORTED_ICON_SIZE;
export const WORKLET_ICON_MAX_BYTES = IMPORTED_ICON_MAX_BYTES;

export class WorkletIconInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkletIconInvalidError";
    }
}

export type WorkletIconArtifacts = IconArtifacts;

/** Validates the identity icon supplied for a worklet and derives display artifacts from it. */
export function createWorkletIconArtifacts(source: Uint8Array): Promise<WorkletIconArtifacts> {
    return createIconArtifacts(source, {
        invalid: (message) => new WorkletIconInvalidError(message),
        subject: "worklet",
    });
}
