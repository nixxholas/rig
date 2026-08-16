# Skills module

`SkillsModule` receives the shared compute resolver and uses the exact cached compute belonging to
the current agent. It recursively discovers user skills under `~/.agents/skills` and project
skills under `.agents/skills` from the nearest Git root down to `compute.cwd`. A deeper project
skill with the same name replaces an earlier one. Hosts may optionally inject additional
TypeBox-validated roots for Rig-shipped (`builtin`) and plugin (`plugin`) filesystem skills, or
durable (`durable`) skills whose complete document is returned by an external reader.

The catalog and skill documents are read live through `compute.fs`, bounded, and exposed through
model instructions plus `list_skills` and `read_skill`. Durable reads use the same `read_skill`
surface and request Auto review/temporary Full access because they cross the local sandbox. The
module owns no database or persistent index. Discovery skips dot-directories, `node_modules`, and
malformed or unreadable skills without hiding the rest of the catalog; `list_skills` uses its
returned cursor to continue a bounded page. Frontmatter metadata is parsed as YAML-compatible
mapping data, including flow maps, aliases, quoted values, and block scalars.
