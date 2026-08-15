import { basename, dirname, join } from "node:path";

import {
    defineAgentTool,
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
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
    MAX_SKILL_COUNT,
    MAX_SKILL_DOCUMENT_BYTES,
    MAX_SKILL_OUTPUT_CHARACTERS,
    skillDocumentSchema,
    skillEntrySchema,
    skillListInputSchema,
    skillListResultSchema,
    skillReadInputSchema,
    type SkillDocument,
    type SkillEntry,
    type SkillListInput,
    type SkillListResult,
    type SkillReadInput,
} from "./Skills.js";

const exact = { additionalProperties: false } as const;
const MAX_SKILL_DISCOVERY_ENTRIES = 4_096;
const MAX_SKILL_FILES_INSPECTED = 256;
const SKILL_DIRECTORY_PAGE_SIZE = 256;

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

export const skillsModuleOptionsSchema = Type.Object(
    { compute: computeResolverSchema },
    exact,
);
export type SkillsModuleOptions = Omit<
    Static<typeof skillsModuleOptionsSchema>,
    "compute"
> & { compute: ComputeResolver };

/** Discovers filesystem skills available to one host compute. */
export class SkillsModule implements AgentModule {
    readonly name = "skills";
    readonly #compute: ComputeResolver;

    constructor(options: SkillsModuleOptions) {
        if (!Value.Check(skillsModuleOptionsSchema, materializeOptions(options))) {
            throw new Error("Skills module options are invalid.");
        }
        this.#compute = options.compute;
    }

    /** Discover a bounded page from the current skill catalog. */
    async list(
        ctx: Context,
        agentId: string,
        input: SkillListInput = {},
    ): Promise<SkillListResult> {
        assertValue(skillListInputSchema, input, "Skill list input");
        const compute = await this.#compute.resolve(ctx, agentId);
        if (compute === undefined) return { skills: [] };
        const entries = await discoverSkills(
            compute,
            computePermissionsForContext(ctx),
        );
        const query = input.query?.trim().toLocaleLowerCase();
        const filtered =
            query === undefined || query.length === 0
                ? entries
                : entries.filter(
                      (entry) =>
                          entry.name.toLocaleLowerCase().includes(query) ||
                          entry.description.toLocaleLowerCase().includes(query),
                  );
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        if (!Number.isSafeInteger(offset)) throw new Error("Skill list cursor is invalid.");
        const result = fitListPage(filtered, offset, input.limit ?? MAX_SKILL_COUNT);
        assertValue(skillListResultSchema, result, "Skill list result");
        return structuredClone(result);
    }

    /** Read one currently discoverable skill by name. */
    async read(
        ctx: Context,
        agentId: string,
        input: SkillReadInput,
    ): Promise<SkillDocument> {
        assertValue(skillReadInputSchema, input, "Skill read input");
        const compute = await this.#compute.resolve(ctx, agentId);
        if (compute === undefined) throw new Error("This agent has no compute.");
        const permissions = computePermissionsForContext(ctx);
        const entries = await discoverSkills(compute, permissions);
        const entry = entries.find((candidate) => candidate.name === input.name);
        if (entry === undefined) throw new Error(`Unknown skill "${input.name}".`);
        const bytes = await compute.fs.readFileBuffer(permissions, entry.location, {
            maxBytes: MAX_SKILL_DOCUMENT_BYTES,
            noFollow: true,
        });
        const document = {
            content: new TextDecoder().decode(bytes),
            location: entry.location,
            name: entry.name,
        };
        assertValue(skillDocumentSchema, document, "Skill document");
        return structuredClone(document);
    }

    readonly instructions = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<string> => {
        const compute = await this.#compute.resolve(ctx, scope.agent.id);
        if (compute === undefined) return "";
        const entries = await discoverSkills(
            compute,
            computePermissionsForContext(ctx),
        );
        return entries.length === 0 ? "" : formatInstructions(entries);
    };

    readonly tools = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<readonly AnyAgentTool[]> => {
        if ((await this.#compute.resolve(ctx, scope.agent.id)) === undefined) return [];
        return [defineAgentTool({
            name: "list_skills",
            description: "List the skills available in the current compute.",
            parameters: skillListInputSchema,
            returnType: skillListResultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                await this.list(ctx, scope.agent.id, input),
            toLLM: (result) => [{ type: "text", text: renderList(result) }],
        }),
        defineAgentTool({
            name: "read_skill",
            description: "Read the complete instructions for one available skill.",
            parameters: skillReadInputSchema,
            returnType: skillDocumentSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                await this.read(ctx, scope.agent.id, input),
            toLLM: (result) => [{ type: "text", text: result.content }],
        })];
    };
}

function materializeOptions(options: SkillsModuleOptions): unknown {
    if (options === null || typeof options !== "object") return options;
    const compute = (options as { compute?: ComputeResolver }).compute;
    return compute === undefined || compute === null || typeof compute !== "object"
        ? options
        : { compute: { resolve: compute.resolve } };
}

interface DiscoveryBudget {
    entries: number;
    files: number;
}

async function discoverSkills(
    compute: HostCompute,
    permissions: ComputePermissions,
): Promise<readonly SkillEntry[]> {
    const byName = new Map<string, SkillEntry>();
    const budget: DiscoveryBudget = { entries: 0, files: 0 };
    for (const root of await skillRoots(compute, permissions)) {
        if (byName.size >= MAX_SKILL_COUNT || budget.entries >= MAX_SKILL_DISCOVERY_ENTRIES) {
            break;
        }
        await discoverSkillRoot(compute, permissions, root, byName, budget);
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverSkillRoot(
    compute: HostCompute,
    permissions: ComputePermissions,
    root: { path: string; source: string },
    byName: Map<string, SkillEntry>,
    budget: DiscoveryBudget,
): Promise<void> {
    try {
        if (!(await compute.fs.exists(permissions, root.path))) return;
    } catch {
        return;
    }
    let rootPath: string;
    try {
        rootPath = await compute.fs.realpath(permissions, root.path);
    } catch {
        return;
    }
    const directories = [rootPath];
    const visitedDirectories = new Set([rootPath]);
    for (
        let directoryIndex = 0;
        directoryIndex < directories.length &&
        budget.entries < MAX_SKILL_DISCOVERY_ENTRIES &&
        budget.files < MAX_SKILL_FILES_INSPECTED &&
        byName.size < MAX_SKILL_COUNT;
        directoryIndex += 1
    ) {
        const directory = directories[directoryIndex]!;
        let after: string | undefined;
        let hasMore = true;
        do {
            let page;
            try {
                page = await compute.fs.readdirPage(permissions, directory, {
                    ...(after === undefined ? {} : { after }),
                    limit: Math.min(
                        SKILL_DIRECTORY_PAGE_SIZE,
                        MAX_SKILL_DISCOVERY_ENTRIES - budget.entries,
                    ),
                });
            } catch {
                break;
            }
            for (const name of page.entries) {
                budget.entries += 1;
                const path = join(directory, name);
                try {
                    const stat = await compute.fs.lstat(permissions, path);
                    if (stat.isSymbolicLink) {
                        const followed = await compute.fs.stat(permissions, path);
                        if (!followed.isDirectory) continue;
                        const canonical = await compute.fs.realpath(permissions, path);
                        if (!visitedDirectories.has(canonical)) {
                            visitedDirectories.add(canonical);
                            directories.push(canonical);
                        }
                        continue;
                    }
                    if (stat.isDirectory) {
                        const canonical = await compute.fs.realpath(permissions, path);
                        if (!visitedDirectories.has(canonical)) {
                            visitedDirectories.add(canonical);
                            directories.push(canonical);
                        }
                        continue;
                    }
                    if (!stat.isFile || name !== "SKILL.md") continue;
                    budget.files += 1;
                    if (budget.files > MAX_SKILL_FILES_INSPECTED) return;
                    const entry = await readSkillEntry(
                        compute,
                        permissions,
                        path,
                        root.source,
                    );
                    if (entry !== undefined && !byName.has(entry.name)) {
                        byName.set(entry.name, entry);
                    }
                } catch {
                    // One invalid, unreadable, or concurrently removed skill does not hide others.
                }
                if (
                    budget.entries >= MAX_SKILL_DISCOVERY_ENTRIES ||
                    byName.size >= MAX_SKILL_COUNT
                ) {
                    return;
                }
            }
            after = page.entries.at(-1);
            hasMore = page.hasMore;
            if (page.entries.length === 0) break;
        } while (
            hasMore &&
            budget.entries < MAX_SKILL_DISCOVERY_ENTRIES &&
            budget.files < MAX_SKILL_FILES_INSPECTED &&
            byName.size < MAX_SKILL_COUNT
        );
    }
}

async function readSkillEntry(
    compute: HostCompute,
    permissions: ComputePermissions,
    location: string,
    source: string,
): Promise<SkillEntry | undefined> {
    try {
        const bytes = await compute.fs.readFileBuffer(permissions, location, {
            maxBytes: MAX_SKILL_DOCUMENT_BYTES,
            noFollow: true,
        });
        if (bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) return undefined;
        const metadata = skillMetadata(
            new TextDecoder().decode(bytes),
            basename(dirname(location)),
        );
        const entry = {
            description: metadata.description,
            location,
            name: metadata.name,
            source,
        };
        return Value.Check(skillEntrySchema, entry) ? entry : undefined;
    } catch {
        return undefined;
    }
}

async function skillRoots(
    compute: HostCompute,
    permissions: ComputePermissions,
): Promise<readonly { path: string; source: string }[]> {
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
        try {
            if (await compute.fs.exists(permissions, join(ancestors[index]!, ".git"))) {
                projectRootIndex = index;
                break;
            }
        } catch {
            // An unreadable ancestor cannot establish the project root.
        }
    }
    const roots = ancestors.slice(0, projectRootIndex + 1).map((directory) => ({
        path: join(directory, ".agents", "skills"),
        source: "project",
    }));
    if (compute.fs.home !== undefined) {
        roots.push({ path: join(compute.fs.home, ".agents", "skills"), source: "user" });
    }
    return roots;
}

function skillMetadata(
    content: string,
    directoryName: string,
): { name: string; description: string } {
    const normalized = content.replaceAll("\r\n", "\n");
    if (!normalized.startsWith("---\n")) {
        return { name: directoryName, description: "" };
    }
    const end = normalized.indexOf("\n---", 4);
    const frontmatter = end < 0 ? "" : normalized.slice(4, end);
    return {
        name: frontmatterValue(frontmatter, "name") ?? directoryName,
        description: frontmatterValue(frontmatter, "description") ?? "",
    };
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
    const lines = frontmatter.split("\n");
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return undefined;
    const value = lines[index]!.slice(key.length + 1).trim();
    if (value === "|" || value === ">") {
        const block: string[] = [];
        for (const line of lines.slice(index + 1)) {
            if (!/^\s/u.test(line)) break;
            block.push(line.trim());
        }
        const separator = value === "|" ? "\n" : " ";
        return block.join(separator).trim();
    }
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
    ) {
        return value.slice(1, -1).trim();
    }
    return value;
}

function fitListPage(
    entries: readonly SkillEntry[],
    offset: number,
    limit: number,
): SkillListResult {
    const skills: SkillEntry[] = [];
    for (const entry of entries.slice(offset, offset + limit)) {
        const candidate = [...skills, entry];
        const hasMore = offset + candidate.length < entries.length;
        const result: SkillListResult = {
            skills: candidate,
            ...(hasMore ? { nextCursor: String(offset + candidate.length) } : {}),
        };
        if (renderList(result).length > MAX_SKILL_OUTPUT_CHARACTERS) break;
        skills.push(entry);
    }
    const hasMore = offset + skills.length < entries.length;
    return {
        skills,
        ...(skills.length > 0 && hasMore
            ? { nextCursor: String(offset + skills.length) }
            : {}),
    };
}

function formatInstructions(entries: readonly SkillEntry[]): string {
    const prefix = [
        "# Skills",
        "",
        "Skills are instruction resources. When a skill is relevant, use read_skill and read the complete document before taking action.",
        "",
        "<available_skills>",
    ];
    const suffix = "</available_skills>";
    const rows: string[] = [];
    for (const entry of entries) {
        const row = `  <skill>\n    <name>${escapeXml(entry.name)}</name>\n    <description>${escapeXml(entry.description)}</description>\n    <location>${escapeXml(entry.location)}</location>\n    <source>${escapeXml(entry.source)}</source>\n  </skill>`;
        if ([...prefix, ...rows, row, suffix].join("\n").length > MAX_SKILL_OUTPUT_CHARACTERS) {
            break;
        }
        rows.push(row);
    }
    return [...prefix, ...rows, suffix].join("\n");
}

function renderList(result: SkillListResult): string {
    const rows = result.skills.map(
        (entry) => `${entry.name} — ${entry.description} (${entry.location})`,
    );
    return `${rows.join("\n") || "No skills available."}${
        result.nextCursor === undefined ? "" : `\nnext_cursor=${result.nextCursor}`
    }`;
}

function escapeXml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function assertValue<T extends TSchema>(
    schema: T,
    value: unknown,
    label: string,
): asserts value is Static<T> {
    if (!Value.Check(schema, value)) throw new Error(`${label} is invalid.`);
}