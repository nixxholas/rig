import { HAPPY_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS, happy } from "happy-plugins";

import { createLocalBashComputeProvider } from "./localBashCompute.ts";

const provider = createLocalBashComputeProvider();
const registration = await happy.compute.register(provider.handlers, {
    provisioningTimeoutMs: HAPPY_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS,
});
await happy.ready("Ready.");

await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
});

await registration.close();
await provider.close();
