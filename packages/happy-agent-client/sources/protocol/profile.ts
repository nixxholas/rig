/** The profile: one installation is one person, and this is what they said about themselves. */

import type { ResourceVersion, Timestamp } from "./common.js";

/** The photo's ThumbHash placeholder; the bytes come from `GET /v0/profile/photo`. */
export interface ProfilePhoto {
    thumbhash: string;
}

/** The profile object. Every field is optional and starts out `null`. */
export interface Profile {
    name: string | null;
    email: string | null;
    photo: ProfilePhoto | null;
    version: ResourceVersion;
    updatedAt: Timestamp;
}

/** `GET`, `PATCH /v0/profile`, and the photo routes all answer with this. */
export interface ProfileResponse {
    profile: Profile;
}

/** `PATCH /v0/profile` — any subset; a field set to `null` is cleared. */
export interface ProfileUpdateRequest {
    name?: string | null;
    email?: string | null;
    /** Echoed verbatim in the events this mutation produces. */
    mutationId?: string;
}
