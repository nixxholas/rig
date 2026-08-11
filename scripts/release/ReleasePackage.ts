export type ReleasePackageKey = "rig" | "rig-connect" | "happy-plugins" | "happy-providers";

export interface ReleasePackage {
    buildArguments: readonly string[];
    commitPrefix: string;
    directory: string;
    key: ReleasePackageKey;
    manifestPath: string;
    tagPrefix: string;
}
