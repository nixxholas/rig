export type ReleasePackageKey = "rig" | "rig-connect" | "happy-plugins";

export interface ReleasePackage {
    buildArguments: readonly string[];
    commitPrefix: string;
    directory: string;
    key: ReleasePackageKey;
    manifestPath: string;
    tagPrefix: string;
}
