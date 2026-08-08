import type { RigProfile, RigProfilePhoto } from "../protocol/index.js";

export function sameRigProfile(first: RigProfile, second: RigProfile): boolean {
    return (
        first.createdAt === second.createdAt &&
        first.email === second.email &&
        first.id === second.id &&
        first.name === second.name &&
        first.parentInstanceId === second.parentInstanceId &&
        first.updatedAt === second.updatedAt &&
        first.version === second.version &&
        sameRigProfilePhoto(first.photo, second.photo)
    );
}

function sameRigProfilePhoto(
    first: RigProfilePhoto | undefined,
    second: RigProfilePhoto | undefined,
): boolean {
    if (first === undefined || second === undefined) return first === second;
    return (
        first.bytes === second.bytes &&
        first.data === second.data &&
        first.height === second.height &&
        first.mediaType === second.mediaType &&
        first.thumbhash === second.thumbhash &&
        first.width === second.width
    );
}
