import { dirname, join } from "node:path";

import {
    type AgentModule,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type Context } from "@steve.kite/stdlib";

import type { ComputePermissions } from "../compute/Compute.js";
import {
    hostComputeSchema,
    type HostCompute,
} from "../compute/ComputeModule.js";
import type { ComputeResolver } from "../compute/ComputeResolver.js";
import { computePermissionsForContext } from "../compute/impl/computePermissionsForContext.js";
import {
    MAX_AGENTS_MD_DOCUMENT_BYTES,
    MAX_AGENTS_MD_DOCUMENTS,
    MAX_AGENTS_MD_OUTPUT_CHARACTERS,
    MAX_AGENTS_MD_TOTAL_BYTES,
    agentsMdDocumentSchema,
    agentsMdSnapshotSchema,
    type AgentsMdSnapshot,
} from "./AgentsMd.js";

const exact = { additionalProperties: false } as const;
const callableSchema = Type.Function([], Type.Any());
const computeResolverSchema = Type.Unsafe<ComputeResolver>(
    Type.Object(
        {
            resolve: Type.Function(
                [
                    Type.Unsafe<Context>(
                        Type.Object({}, { additionalProperties: true }),
                    ),
                    Type.String({ minLength: 1 }),
                ],
                Type.Promise(Type.Union([hostComputeSchema, Type.Undefined()])),
            ),
        },
        exact,
    ),
);

export const agentsMdModuleOptionsSchema = Type.Object(
    { compute: computeResolverSchema },
    exact,
);
export type AgentsMdModuleOptions = Omit<
    Static<typeof agentsMdModuleOptionsSchema>,
    "compute"
> & { compute: ComputeResolver };

/** Supplies the AGENTS.md files that apply to the compute working directory. */
export class AgentsMdModule implements AgentModule {
    readonly name = "agents-md";
    readonly #compute: ComputeResolver;

    constructor(options: AgentsMdModuleOptions) {
        if (!Value.Check(agentsMdModuleOptionsSchema, materializeOptions(options))) {
            throw new Error("AGENTS.md module options are invalid.");
        }
        this.#compute = options.compute;
    }

    /** Discover and read the current filesystem snapshot without caching or persistence. */
    async read(ctx: Context, agentId: string): Promise<AgentsMdSnapshot | undefined> {
        const compute = await this.#compute.resolve(ctx, agentId);
        if (compute === undefined) return undefined;
        const permissions = computePermissionsForContext(ctx);
        const directories = await relevantDirectories(compute, permissions);
        const documents: AgentsMdSnapshot["documents"][number][] = [];
        let totalBytes = 0;

        for (const directory of directories) {
            const path = join(directory, "AGENTS.md");
            if (!(await compute.fs.exists(permissions, path))) continue;
            const bytes = await compute.fs.readFileBuffer(permissions, path, {
                maxBytes: MAX_AGENTS_MD_DOCUMENT_BYTES,
                noFollow: true,
            });
            totalBytes += bytes.byteLength;
            if (totalBytes > MAX_AGENTS_MD_TOTAL_BYTES) {
                throw new Error("AGENTS.md documents exceed the total size limit.");
            }
            const document = { path, text: new TextDecoder().decode(bytes).trim() };
            if (document.text.length === 0) continue;
            if (!Value.Check(agentsMdDocumentSchema, document)) {
                throw new Error(`AGENTS.md document is invalid: ${path}`);
            }
            documents.push(document);
            if (documents.length > MAX_AGENTS_MD_DOCUMENTS) {
                throw new Error("Too many applicable AGENTS.md documents.");
            }
        }

        const snapshot = { cwd: compute.cwd, documents };
        if (!Value.Check(agentsMdSnapshotSchema, snapshot)) {
            throw new Error("AGENTS.md filesystem snapshot is invalid.");
        }
        return structuredClone(snapshot);
    }

    readonly instructions = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<string> => {
        const snapshot = await this.read(ctx, scope.agent.id);
        return snapshot === undefined ? "" : formatInstructions(snapshot);
    };

}

function materializeOptions(options: AgentsMdModuleOptions): unknown {
    if (options === null || typeof options !== "object") return options;
    const compute = (options as { compute?: ComputeResolver }).compute;
    return compute === undefined || compute === null || typeof compute !== "object"
        ? options
        : { compute: { resolve: compute.resolve } };
}

async function relevantDirectories(
    compute: HostCompute,
    permissions: ComputePermissions,
): Promise<readonly string[]> {
    const ancestors: string[] = [];
    let current = compute.cwd;
    while (true) {
        ancestors.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    let projectRootIndex = 0;
    for (let index = 0; index < ancestors.length; index += 1) {
        if (await compute.fs.exists(permissions, join(ancestors[index]!, ".git"))) {
            projectRootIndex = index;
            break;
        }
    }
    return ancestors.slice(0, projectRootIndex + 1).reverse();
}

function formatInstructions(snapshot: AgentsMdSnapshot): string {
    if (snapshot.documents.length === 0) return "";
    const sections = snapshot.documents.map(
        (document) =>
            `# AGENTS.md instructions for ${dirname(document.path)}\n\n<INSTRUCTIONS>\n${document.text}\n</INSTRUCTIONS>`,
    );
    const result = sections.join("\n\n");
    if (result.length > MAX_AGENTS_MD_OUTPUT_CHARACTERS) {
        throw new Error("AGENTS.md instructions exceed the output limit.");
    }
    return result;
}