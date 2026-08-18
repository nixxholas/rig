/**
 * The complete Happy agent surface.
 *
 * Agent Base owns the runtime and persistence contract. Agent Modules supplies the reusable
 * capabilities installed into that runtime. Compute remains namespaced because it is a host
 * boundary with several backend constructors, rather than agent behavior on its own.
 */
export * from "@slopus/happy-agent-base";
export * from "@slopus/happy-agent-modules";
export * as compute from "@slopus/happy-agent-compute";
export * from "./main.js";
export * from "./modules/index.js";
export {
    startHappyAgent,
    type HappyAgentModules,
    type StartedHappyAgent,
    type StartHappyAgentOptions,
} from "./start/startHappyAgent.js";
