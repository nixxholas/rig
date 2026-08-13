import { release } from "node:os";

import { Type, type Static } from "@sinclair/typebox";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

/** The operating systems Node reports, mirroring `NodeJS.Platform`. */
export const agentPlatformSchema = Type.Union([
    Type.Literal("aix"),
    Type.Literal("android"),
    Type.Literal("cygwin"),
    Type.Literal("darwin"),
    Type.Literal("freebsd"),
    Type.Literal("haiku"),
    Type.Literal("linux"),
    Type.Literal("netbsd"),
    Type.Literal("openbsd"),
    Type.Literal("sunos"),
    Type.Literal("win32"),
]);

export type AgentPlatform = Static<typeof agentPlatformSchema>;

/**
 * The settings one feature was configured with. The agent never looks inside: a feature owns
 * the shape of its own entry and validates it against its own schema.
 */
export const agentFeatureConfigSchema = Type.Record(Type.String(), Type.Unknown());

export type AgentFeatureConfig = Static<typeof agentFeatureConfigSchema>;

/**
 * The machine an agent works on. It is all or nothing: an agent either knows its environment
 * completely or not at all, so nothing it is told about the machine is ever half-true.
 */
export const agentEnvironmentSchema = Type.Object({
    /** The operating system release, as a human-readable version string. */
    osVersion: Type.String(),
    platform: agentPlatformSchema,
    /** The absolute path the agent's work is rooted at. */
    workingDirectory: Type.String(),
    /** The shell the agent's commands run in, such as `/bin/zsh`. */
    shell: Type.String(),
});

export type AgentEnvironment = Static<typeof agentEnvironmentSchema>;

/**
 * What an agent was created with: the environment it works on, when it has one, and one opaque
 * settings map per feature, keyed by the feature's name. The configuration is static for the
 * agent's whole life and is persisted when the agent is created, so a later process resolves
 * the very same agent it was created as.
 */
export const agentConfigSchema = Type.Object({
    environment: Type.Optional(agentEnvironmentSchema),
    /** Per-feature settings, keyed by feature name; each entry is opaque to the agent. */
    features: Type.Optional(Type.Record(Type.String(), agentFeatureConfigSchema)),
});

export type AgentConfig = Static<typeof agentConfigSchema>;

/**
 * The environment this process is running in, ready to be handed to an agent at creation. The
 * platform is typed, so a Node release reporting an unknown platform fails to compile rather
 * than slipping into a persisted configuration; an unset `SHELL` reports as no shell at all.
 */
export function currentAgentEnvironment(): AgentEnvironment {
    const platform: AgentPlatform = process.platform;
    return {
        osVersion: release(),
        platform,
        workingDirectory: process.cwd(),
        shell: process.env.SHELL ?? "",
    };
}

const configNamespace = createContextNamespace<AgentConfig | undefined>(
    "happyAgentBase.agentConfig",
    undefined,
);

/** Carry the configuration an agent was created with; every hook and tool reads it back. */
export function withAgentConfig(ctx: Context, config: AgentConfig): Context {
    return configNamespace.set(ctx, config);
}

/** The configuration of the agent owning this context, when one was attached. */
export function agentConfig(ctx: Context): AgentConfig | undefined {
    return configNamespace.get(ctx);
}

/** The environment of the agent owning this context, when it was created with one. */
export function agentEnvironment(ctx: Context): AgentEnvironment | undefined {
    return configNamespace.get(ctx)?.environment;
}

/** The opaque settings the named feature was configured with, if it was configured at all. */
export function agentFeatureConfig(ctx: Context, name: string): AgentFeatureConfig | undefined {
    return configNamespace.get(ctx)?.features?.[name];
}
