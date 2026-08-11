export const CANARY_PACKAGES = [
    {
        npmName: "@slopus/happy-providers",
        output: "providers",
        path: "packages/happy-providers",
    },
    {
        npmName: "happy-plugins",
        output: "plugins",
        path: "packages/happy-plugins",
    },
    {
        npmName: "@slopus/rig-connect",
        output: "connect",
        path: "packages/rig-connect",
    },
] as const;
