import { registerHooks } from "node:module";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SDK_DIRECTORY_PARAMETER = "sdk";
const sdkDirectory = new URL(import.meta.url).searchParams.get(SDK_DIRECTORY_PARAMETER);
if (sdkDirectory === null || sdkDirectory.length === 0) {
    throw new Error("Rig did not provide its Happy plugin SDK directory.");
}
const sdkRoot = pathToFileURL(`${resolve(sdkDirectory)}${sep}`);
const sdkExports = new Map([
    ["happy-plugins", new URL("index.js", sdkRoot).href],
    ["happy-plugins/internal", new URL("internal.js", sdkRoot).href],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const shipped = sdkExports.get(specifier);
        return shipped === undefined
            ? nextResolve(specifier, context)
            : { shortCircuit: true, url: shipped };
    },
});
