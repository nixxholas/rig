import { Type, type Static } from "@sinclair/typebox";
import type { RootContext } from "@steve.kite/stdlib";

import type { GitCommandRunner } from "../git/GitCommandRunner.js";
import type { GitCredentialBroker } from "../git/GitCredentialBroker.js";
import type { cloneRemoteRepository } from "../git/cloneRemoteRepository.js";
import type { ProjectCreator } from "../git/types.js";

import type { ProjectRemoteSource } from "./Project.js";
import { projectContextSchema } from "./ProjectEvent.js";

/**
 * Who a person is when Git records their work.
 *
 * Cloning a remote repository on someone's behalf needs their name and address for the commits
 * that follow, and `parentInstanceId` to confirm the profile still belongs to the machine that
 * asked. The catalog does not own profiles, so it asks for one by identifier and refuses to clone
 * when the answer does not come back.
 */
export const projectCreatorProfileSchema = Type.Object(
    {
        email: Type.String({ minLength: 1, maxLength: 320 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        parentInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type ProjectCreatorProfile = Static<typeof projectCreatorProfileSchema>;

/** A folder the catalog is asked to adopt as a project without starting a session in it. */
export interface RegisterProjectRequest {
    readonly path: string;
    readonly projectId?: string;
}

/** A project whose folder does not exist yet, because its repository still has to be cloned. */
export interface CreateRemoteProjectRequest {
    readonly name: string;
    readonly projectId?: string;
    readonly secret?: { readonly kind: "github" };
    readonly source: ProjectRemoteSource;
}

/** Who asked for a managed project or workspace, and with which credential. */
export interface ProjectCreatorOptions {
    readonly createdBy?: ProjectCreator;
    readonly githubToken?: string;
}

/**
 * The lifetime the catalog's own work runs on: a detached root the caller derives named child
 * lifetimes from, carrying the agent database. A clone, a setup pass, or an avatar sweep outlives
 * the request that started it, so it never runs on that request's context.
 */
export const projectRootContextSchema = Type.Unsafe<RootContext>(
    Type.Object({}, { additionalProperties: true }),
);

export const projectGitRunnerSchema = Type.Unsafe<GitCommandRunner>(
    Type.Object({}, { additionalProperties: true }),
);
export const projectGitCredentialBrokerSchema = Type.Unsafe<GitCredentialBroker>(
    Type.Object({}, { additionalProperties: true }),
);
export const projectCloneRemoteSchema = Type.Unsafe<typeof cloneRemoteRepository>(
    Type.Function([Type.Unknown()], Type.Promise(Type.Void())),
);
export const projectCreatorOptionSchema = Type.Unsafe<ProjectCreator>(
    Type.Object({}, { additionalProperties: true }),
);
export const projectEnvironmentSchema = Type.Unsafe<NodeJS.ProcessEnv>(
    Type.Object({}, { additionalProperties: true }),
);
export const projectSecretResolverSchema = Type.Unsafe<(kind: "github") => string | undefined>(
    Type.Function([Type.String()], Type.Union([Type.String(), Type.Undefined()])),
);
/**
 * Answers who a profile is. The catalog knows which machine it is and says so, because a profile
 * resolved for a clone records the instance the commits will be attributed through.
 */
export const projectProfileResolverSchema = Type.Unsafe<
    (
        profileId: string,
        instanceId: string,
    ) => ProjectCreatorProfile | undefined | Promise<ProjectCreatorProfile | undefined>
>(Type.Function([Type.String(), Type.String()], Type.Unknown()));
export const projectNowSchema = Type.Function([], Type.Number());
export const projectHostErrorSchema = Type.Function(
    [projectContextSchema, Type.String(), Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
