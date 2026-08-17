import type sharp from "sharp";

let imageProcessor: typeof sharp | undefined;

/**
 * Sharp, loaded the first time an image is actually handled.
 *
 * It is a native module and only image work needs it, so the cost of loading it belongs to the
 * first generation rather than to starting the agent.
 */
export async function getImageProcessor(): Promise<typeof sharp> {
    if (imageProcessor !== undefined) {
        return imageProcessor;
    }

    const imported = await import("sharp");
    imageProcessor = imported.default;
    return imageProcessor;
}
