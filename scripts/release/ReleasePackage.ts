export type ReleasePackageKey = "rig" | "rig-connect";

export interface ReleasePackage {
    buildArguments: readonly string[];
    commitPrefix: string;
    directory: string;
    key: ReleasePackageKey;
    manifestPath: string;
    tagPrefix: string;
}
