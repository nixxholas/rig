export type ReleasePackageKey =
    | "rig"
    | "rig-connect"
    | "happy-agent-base"
    | "happy-agent-compute"
    | "happy-plugins"
    | "happy-providers";

export interface ReleasePackage {
    buildArguments: readonly string[];
    checkArguments: readonly string[];
    commitPrefix: string;
    directory: string;
    key: ReleasePackageKey;
    manifestPath: string;
    tagPrefix: string;
    testArguments: readonly (readonly string[])[];
}
