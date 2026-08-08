import {
    createIconArtifacts,
    IMPORTED_ICON_MAX_BYTES,
    IMPORTED_ICON_SIZE,
    type IconArtifacts,
} from "../imports/createIconArtifacts.js";

export const APPLET_ICON_SIZE = IMPORTED_ICON_SIZE;
export const APPLET_ICON_MAX_BYTES = IMPORTED_ICON_MAX_BYTES;

export class AppletIconInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AppletIconInvalidError";
    }
}

export type AppletIconArtifacts = IconArtifacts;

/**
 * Validates the identity icon supplied for an applet and derives display artifacts from it.
 *
 * `png` deliberately remains the exact supplied bytes. The ICO contains PNG frames with a
 * transparent superellipse mask, matching the softly rounded macOS icon silhouette.
 */
export function createAppletIconArtifacts(source: Uint8Array): Promise<AppletIconArtifacts> {
    return createIconArtifacts(source, {
        invalid: (message) => new AppletIconInvalidError(message),
        subject: "applet",
    });
}
