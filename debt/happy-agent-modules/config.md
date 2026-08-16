# Module report: config

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/config/` compared against Rig's
configuration loader (`packages/rig/sources/config/`), root `AGENTS.md`, and master plans 00, 05,
09, 16, 20, 21.

## Summary

`ConfigModule` is a 1,971-line single file (`ConfigModule.ts`) that re-implements Rig's
configuration loader: the same three layers, the same TOML dialect, the same merge order, the same
`withoutProjectMachineSettings` rule down to the function name. It is not really a module in the
plan-20/21 sense — it has no tools, no hooks, no events, no `AgentKV` state and no per-agent
behavior; `implements AgentModule` (`ConfigModule.ts:760`) supplies only a `name` and a
`configuration` property. It is a loader wearing the module interface so it can be listed with the
others.

## How it differs from Rig's equivalent

- **One file against fifty.** Rig's `packages/rig/sources/config/` is 4,891 lines across ~50 files,
  each named for what it does: `loadConfig.ts`, `mergeConfigValues.ts`, `parseConfigToml.ts`,
  `readConfigFile.ts`, `readProjectConfigFile.ts`, `resolveConfigPaths.ts`,
  `withoutProjectMachineSettings.ts`, `resolveProtectedPaths.ts`. The module collapses all of it
  into `ConfigModule.ts`: schemas, defaults, path derivation, the TOML reader, twelve section
  parsers, twelve normalizers, two mergers, and provenance. AGENTS.md: "A file should hold one
  coherent piece of behavior. Most product code lands at one function per file." Rig's own config
  directory is the in-repo demonstration of that rule; this file is its opposite.
- **The same logic, twice, live.** `loadConfig` (`packages/rig/sources/config/loadConfig.ts:9-30`)
  and `ConfigModule.load` (`ConfigModule.ts:768-789`) read the same three files in the same order
  and merge them the same way; `withoutProjectMachineSettings` exists in both
  (`ConfigModule.ts:1413-1437` and `packages/rig/sources/config/withoutProjectMachineSettings.ts`)
  and strips the same keys. Rig's copy is still the one Rig uses. Two independently maintained
  parsers for one user-visible `happy.toml` is a divergence waiting to happen — a key accepted by
  one and reported as unknown by the other is a silent behavior difference inside one product.
- **TypeBox instead of hand-written interfaces.** Rig's `config/types.ts:9-47` hand-writes
  `ConfigDefaults`, `PartialConfigDefaults`, `ConfigSettings`, `PartialConfigSettings` as parallel
  interfaces; the module derives everything from schemas (`ConfigModule.ts:660-696`). On the
  runtime-validation rule the module is right and Rig is wrong.

## Findings

1. **The module reads ambient `process.cwd()`.** `derivePaths` sets
   `localConfigPath: join(process.cwd(), "rig.toml")` (`ConfigModule.ts:993`). A library module that
   resolves user configuration from the process working directory cannot be used twice in one
   process for two projects, and its result depends on where the binary happened to be started.
   Every other path in that function derives from the explicit `happyHome` input
   (`ConfigModule.ts:975-1000`).
2. **The README describes two layers; the code has three.** The README says the module "reads the
   global `Happy/Config/happy.toml` and private `<happyRoot>/agent/runtime.toml` layers" and its
   diagram shows only those files. The loader also reads a project layer — `rig.toml` in the cwd,
   falling back to `happy.toml` beside it (`readProjectConfigSource`, `ConfigModule.ts:942-946`) —
   filters machine-only settings out of it (`ConfigModule.ts:775`, `1413-1437`), and reports it as
   `sources.local` (`ConfigModule.ts:776-784`). The layer that carries the security-relevant
   filtering is the one the documentation omits.
3. **Provider type inference is implemented twice, with different messages.**
   `inferProviderType` (`ConfigModule.ts:1396-1411`) throws
   `Built-in provider "<id>" must use type "<builtIn>".`; a second copy inside the provider reader
   (`ConfigModule.ts:1855`) throws `Built-in provider "<id>" must use type "<id>".` for the same
   condition. The docker "exactly one of container or image" rule is likewise duplicated at
   `ConfigModule.ts:1136` (normalize) and `ConfigModule.ts:1600` (read), as is the absolute-workdir
   check. Two copies of one rule in one file is how the two copies eventually disagree.
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
   threaded through `ReadSource`, published in the snapshot (`ConfigModule.ts:642`, `812-820`,
   `892`) and read by no consumer in the repository.
7. **Validation runs four times over the same bytes.** Each section reader validates its slice
   against a section schema, the assembled partial is checked against `partialValuesSchema`
   (`ConfigModule.ts:873-875`), the merged result against `happyAgentConfigValuesSchema`
   (`ConfigModule.ts:1066-1068`), and the whole configuration again (`ConfigModule.ts:787-789`).
   The last three can only fail if the module's own normalizers are wrong — over-validation of an
   internal contract, paid on every startup.
8. **Hardcoded product defaults sit inside the parser.** `DEFAULT_VALUES` names a specific model
   (`ConfigModule.ts:701`: `modelId: "openai/gpt-5.6-sol"`), a theme, a p2p posture, and the
   provider list, in the middle of the TOML-reading file. Rig keeps the equivalent in its own
   `config/defaultConfig.ts`. AGENTS.md wants the model catalog hardcoded in source — but not in
   the config reader.
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

## What it gets right

- The layering rule itself is right and carefully implemented: a project's `rig.toml` cannot set
  `permission_mode`, docker, providers, p2p, or the machine-level settings
  (`withoutProjectMachineSettings`, `ConfigModule.ts:1413-1437`). That is the security-relevant part
  of configuration and it is enforced before the merge, not after.
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
