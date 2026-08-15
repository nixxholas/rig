import { resolve } from "node:path";

import { createJiti } from "jiti/static";

const [, , entryPathArgument, sdkEntryArgument] = process.argv;
if (entryPathArgument === undefined || sdkEntryArgument === undefined) {
    throw new Error("Rig did not provide both the worklet entry point and SDK.");
}

const entryPath = resolve(entryPathArgument);
const sdkEntry = resolve(sdkEntryArgument);
const jiti = createJiti(import.meta.url, {
    alias: { "happy-worklets": sdkEntry },
    interopDefault: true,
    moduleCache: false,
    tryNative: false,
});

await jiti.import(entryPath);
