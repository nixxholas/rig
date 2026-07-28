import { assertReleaseTagMatchesPackageVersion } from "./release/assertReleaseTagMatchesPackageVersion.js";
import { readPackageManifest } from "./release/readPackageManifest.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag === undefined || releaseTag.length === 0) {
    throw new Error("RELEASE_TAG must contain the tag that triggered the release.");
}

const releasePackage = resolveReleasePackage(process.env.RELEASE_PACKAGE);
const manifest = readPackageManifest(releasePackage);
assertReleaseTagMatchesPackageVersion(releaseTag, manifest, releasePackage.tagPrefix);
console.log(`${releaseTag} matches ${manifest.name}@${manifest.version}.`);
