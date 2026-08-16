# Module report: config

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/config/` as the v2 rewrite of
Rig's configuration loader (`packages/rig/sources/config/`), judged against the root `AGENTS.md` and
master plans 00, 05, 09, 16, 20, 21.

## Summary

`ConfigModule` is the rewrite's configuration loader: three layers, one TOML dialect, a merge order,
provenance, and the machine-setting filter that keeps a project file from raising its own privileges.
The layering and bounding work is careful and the security-relevant filter is enforced before the
merge. Its main debts are structural: the whole loader is one 1,971-line file
(`ConfigModule.ts`) where AGENTS.md asks for one coherent piece of behavior per file, several rules
inside that file are implemented twice with different messages, it resolves the project layer from
ambient `process.cwd()`, and its README omits the very layer that carries the security filtering. It
is also not really a module in the plan-20/21 sense — no tools, hooks, events, `AgentKV` state, or
per-agent behavior; `implements AgentModule` (`ConfigModule.ts:760`) supplies only a `name` and a
`configuration` property. That may be fine for a loader, but it is worth naming rather than
inferring.

## Changes from the Rig v1 implementation

- **One file where v1 had a directory.** V1's `packages/rig/sources/config/` is 4,891 lines across
  ~50 files, each named for what it does: `loadConfig.ts`, `mergeConfigValues.ts`,
  `parseConfigToml.ts`, `readConfigFile.ts`, `readProjectConfigFile.ts`, `resolveConfigPaths.ts`,
  `withoutProjectMachineSettings.ts`, `resolveProtectedPaths.ts`. The rewrite collapses all of it
  into `ConfigModule.ts`: schemas, defaults, path derivation, the TOML reader, twelve section
  parsers, twelve normalizers, two mergers, and provenance. AGENTS.md: "A file should hold one
  coherent piece of behavior. Most product code lands at one function per file." V1's config
  directory is the in-repo demonstration of that rule; this file is its opposite, and findings 3 and
  4 are direct consequences of the size.
- **Both loaders are live during the transition.** `loadConfig`
  (`packages/rig/sources/config/loadConfig.ts:9-30`) and `ConfigModule.load`
  (`ConfigModule.ts:768-789`) read the same three files in the same order and merge them the same
  way; `withoutProjectMachineSettings` exists in both (`ConfigModule.ts:1413-1437` and
  `packages/rig/sources/config/withoutProjectMachineSettings.ts`) and strips the same keys. Until v1
  is retired, one user-visible `happy.toml` has two independently maintained parsers, and a key
  accepted by one and reported as unknown by the other is a silent behavior difference inside one
  product. This is transition debt with a defined end: track the cutover, and do not fix bugs in
  only one copy meanwhile.
- **TypeBox instead of hand-written interfaces — a deliberate improvement.** V1's `config/types.ts:9-47`
  hand-writes `ConfigDefaults`, `PartialConfigDefaults`, `ConfigSettings`, `PartialConfigSettings` as
  parallel interfaces; the rewrite derives everything from schemas (`ConfigModule.ts:660-696`), which
  is what the AGENTS.md runtime-validation rule requires.
- **Product defaults moved into the parser — a step back.** V1 keeps them in `config/defaultConfig.ts`;
  the rewrite inlines them (finding 8).

## Findings

1. **The module reads ambient `process.cwd()`.** `derivePaths` sets
   `localConfigPath: join(process.cwd(), "rig.toml")` (`ConfigModule.ts:993`). A library module that
   resolves user configuration from the process working directory cannot be used twice in one
   process for two projects, and its result depends on where the binary happened to be started.
   Every other path in that function derives from the explicit `happyHome` input
   (`ConfigModule.ts:975-1000`), so the fix is to take the project directory as an input too.
2. **The README describes two layers; the code has three.** The README says the module "reads the
   global `Happy/Config/happy.toml` and private `<happyRoot>/agent/runtime.toml` layers" and its
   diagram shows only those files. The loader also reads a project layer — `rig.toml` in the cwd,
   falling back to `happy.toml` beside it (`readProjectConfigSource`, `ConfigModule.ts:942-946`) —
   filters machine-only settings out of it (`ConfigModule.ts:775`, `1413-1437`), and reports it as
   `sources.local` (`ConfigModule.ts:776-784`). The layer that carries the security-relevant
   filtering is the one the documentation omits, which is the worst possible omission: a reader of
   the README cannot tell that a repository-supplied file is an input at all, let alone that a
   filter is what keeps it safe.
3. **Provider type inference is implemented twice, with different messages.** `inferProviderType`
   (`ConfigModule.ts:1396-1411`) throws `Built-in provider "<id>" must use type "<builtIn>".`; a
   second copy inside the provider reader (`ConfigModule.ts:1855`) throws
   `Built-in provider "<id>" must use type "<id>".` for the same condition. The docker "exactly one
   of container or image" rule is likewise duplicated at `ConfigModule.ts:1136` (normalize) and
   `ConfigModule.ts:1600` (read), as is the absolute-workdir check. Two copies of one rule in one
   file is how the two copies eventually disagree.
4. **Provenance is a hand-maintained snake_case-to-camelCase table.** `calculateProvenance`
   (`ConfigModule.ts:1439-1486`) carries `sectionNames` and a per-section `fieldNames` map that must
   be kept in sync by hand with the normalizers elsewhere in the file — `normalizeSettings` is at
   `ConfigModule.ts:1100`, five hundred lines away. A key renamed in one and not the other silently
   reports provenance under the raw TOML key, and nothing fails when they disagree. The record is
   also built unbounded and only bounded afterwards by `MAX_PROVENANCE_ENTRIES` in the final schema
   check (`ConfigModule.ts:649-657`, `787-789`).
5. **Every structural failure is one of a handful of opaque messages.** "The Happy Agent
   configuration is invalid." (`ConfigModule.ts:788`), "The merged Happy Agent configuration is
   invalid." (`ConfigModule.ts:1067`), "The Happy Agent configuration contains an invalid value."
   (`ConfigModule.ts:874`), "presence contains an invalid value." (`ConfigModule.ts:1739`),
   "`<name>` contains an invalid value." (`ConfigModule.ts:1892`). None names the file, the section,
   the key, or the value. This is the first thing a user sees after mistyping a setting, and
   AGENTS.md requires user-facing text to be human-readable. The file's own hand-written checks show
   what good looks like — `docker must configure exactly one of "container" or "image".`
   (`ConfigModule.ts:1600`), `p2p.iroh.relay_url must be an HTTP or HTTPS URL.`
   (`ConfigModule.ts:1666`) — so the file is inconsistent with itself.
6. **Dead parameter, unread flag.** `readConfigSource(path, _kind)` takes a `ConfigSourceKind` it
   never uses (`ConfigModule.ts:948`); the three call sites pass `"global"`, `"local"`, `"runtime"`
   for nothing (`ConfigModule.ts:771-773`, `943-945`). `unknownSettingsTruncated` is computed,
   threaded through `ReadSource`, published in the snapshot (`ConfigModule.ts:642`, `812-820`, `892`)
   and read by no consumer in the repository.
7. **Validation runs four times over the same bytes.** Each section reader validates its slice
   against a section schema, the assembled partial is checked against `partialValuesSchema`
   (`ConfigModule.ts:873-875`), the merged result against `happyAgentConfigValuesSchema`
   (`ConfigModule.ts:1066-1068`), and the whole configuration again (`ConfigModule.ts:787-789`). The
   last three can only fail if the module's own normalizers are wrong — over-validation of an
   internal contract, paid on every startup.
8. **Hardcoded product defaults sit inside the parser.** `DEFAULT_VALUES` names a specific model
   (`ConfigModule.ts:701`: `modelId: "openai/gpt-5.6-sol"`), a theme, a p2p posture, and the provider
   list, in the middle of the TOML-reading file. V1 keeps the equivalent in its own
   `config/defaultConfig.ts`. AGENTS.md wants the model catalog hardcoded in source — but not in the
   config reader.
9. **One constant stands in for six unrelated limits.** `MAX_CONFIG_TABLE_ENTRIES = 512`
   (`ConfigModule.ts:15`) bounds MCP servers, docker environment variables, HTTP headers, Bedrock
   model overrides, presence states, and the untyped `sources[].values` record
   (`ConfigModule.ts:643-645`). None can be tuned independently, and exceeding any of them produces
   the generic message from finding 5.
10. **Three merge semantics, none documented at the point of use.** Most sections `Object.assign`
    onto the defaults; `network` and `docker` replace wholesale (`ConfigModule.ts:1015`, `1023`);
    `p2p` and `presence` deep-merge through bespoke `mergeP2p` / `mergePresence`
    (`ConfigModule.ts:1272`, `1290`). A user cannot predict from the file which of their global
    settings a runtime file will preserve.
11. **Master-plan naming.** The master plans place ready-made capabilities in
    `@slopus/happy-agent-features` and have not yet been updated to name `happy-agent-modules`; the
    plans need the user's dictation to catch up with the rewrite direction.

## What it gets right

- The layering rule itself is right and carefully implemented: a project's `rig.toml` cannot set
  `permission_mode`, docker, providers, p2p, or the machine-level settings
  (`withoutProjectMachineSettings`, `ConfigModule.ts:1413-1437`). That is the security-relevant part
  of configuration and it is enforced before the merge, not after — v1's protection carried forward
  intact.
- Unknown keys are recorded rather than rejected, with an explicit truncation flag and a bound
  (`recordUnknown`, `ConfigModule.ts:813-825`), so a config written for a newer build still loads,
  while malformed TOML and invalid known values still fail. That is the right split.
- Missing files are a normal outcome, not an error (`ConfigModule.ts:956-965`), and the returned
  configuration is deep-frozen (`ConfigModule.ts:789`, `1068`) so no downstream module can mutate
  shared settings.
- Every input carries an explicit byte, length, item, or property bound (`ConfigModule.ts:10-19`),
  including the file itself, so a hostile or corrupt config cannot exhaust memory during parse.
- The cross-field checks are genuinely useful and well worded: exactly one of `container`/`image`,
  absolute `workdir` and mount targets, `primary_id` only with `role = "secondary"`, HTTP(S)
  `relay_url`, built-in provider type agreement, and MCP servers requiring exactly one of `command`
  or `url` (`ConfigModule.ts:1587-1620`, `1650-1670`, `1396-1411`).
