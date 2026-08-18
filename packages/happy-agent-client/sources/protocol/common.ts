/**
 * The small values every chapter of the API shares.
 *
 * Types in this package are hand-written rather than derived from a schema
 * library: the client ships with zero runtime dependencies, so nothing here is
 * validated at runtime. Every shape is a compile-time promise about what the
 * daemon sends, kept faithful to `packages/happy-agent/API.md`.
 *
 * Closed unions describe the values the specification names today. The
 * specification says several of these sets grow with the product, so a value
 * arriving from a newer daemon simply matches no variant: branch with `default`
 * rather than asserting exhaustiveness.
 */

/** A CUID2 identifier: opaque, URL-safe, and never ordered by the client. */
export type Cuid2 = string;

/** A UUIDv7 position in the event journal; greater means newer. */
export type EventCursor = string;

/** A UUIDv7 resource version, minted at the moment the resource changed. */
export type ResourceVersion = string;

/** Unix epoch milliseconds. */
export type Timestamp = number;

/**
 * An effort level, named by the config catalog (`"medium"`, `"xhigh"`, …).
 *
 * The catalog is data the daemon serves rather than a fixed set, so the allowed
 * values for a model are read from its definition in `GET /v0/config`.
 */
export type Effort = string;

/** A service tier, named by the config catalog; `null` means the default tier. */
export type ServiceTier = string;

/** How much a run is allowed to do without asking. */
export type PermissionMode = "read_only" | "workspace_write" | "auto" | "full_access";

/** The model selection and permission mode a message runs with. */
export interface MessageMode {
    providerId: string;
    modelId: string;
    effort: Effort;
    serviceTier: ServiceTier | null;
    permissionMode: PermissionMode;
}

/** Where files live and where work on them executes. */
export type Compute = HostCompute | DockerCompute;

export interface HostCompute {
    type: "host";
    path: string;
}

export interface DockerCompute {
    type: "docker";
    image: string;
}

/** A compute choice made before anything runs, so it carries no addressing yet. */
export type ComputeSelection = { type: "host" } | { type: "docker"; image: string };

/** How far a project or workspace got through its setup. */
export interface InitializationState {
    status: "initializing" | "ready" | "failed";
    /** How many setup runs have been attempted. */
    attempt: number;
    /** A human-readable message when setup failed. */
    error: string | null;
}

/** Where a repository stands, as reported on projects, workspaces, and git state. */
export interface GitSummary {
    /** The current branch; absent or `null` on a detached HEAD. */
    branch?: string | null;
    detached: boolean;
    head: string;
    upstream: string | null;
    ahead: number;
    behind: number;
}

/** Options every request accepts. */
export interface RequestOptions {
    /** Cancels the request; the rejection is the signal's abort reason. */
    signal?: AbortSignal | undefined;
}

/** Options for a mutation the daemon guards with `If-Match`. */
export interface VersionedRequestOptions extends RequestOptions {
    /** The `version` the client last saw, sent as the `If-Match` header. */
    ifMatch: string;
}

/** Options for a mutation that honors `If-Match` without requiring it. */
export interface OptionallyVersionedRequestOptions extends RequestOptions {
    /** The `version` the client last saw, sent as the `If-Match` header. */
    ifMatch?: string | undefined;
}

/** An image the daemon accepts as a picture. */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** Bytes to upload, in whichever form the caller already holds them. */
export type BinaryData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

/** An image being uploaded. */
export interface ImageUpload {
    contentType: ImageMimeType;
    data: BinaryData;
}

/** Image bytes served by the daemon. */
export interface BinaryContent {
    contentType: string;
    data: ArrayBuffer;
    /** The entity tag, when the endpoint serves conditional requests. */
    etag: string | null;
}
