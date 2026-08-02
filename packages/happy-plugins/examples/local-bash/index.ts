import { happy } from "happy-plugins";

import { createLocalBashComputeProvider } from "./localBashCompute.ts";

const provider = createLocalBashComputeProvider();
const registration = await happy.compute.register(provider.handlers);
await happy.ready("Ready.");

await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
});

await registration.close();
await provider.close();
