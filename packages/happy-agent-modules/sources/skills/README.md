# Skills module

`SkillsModule` receives the shared compute resolver and uses the exact cached compute belonging to
the current agent. It recursively discovers user skills under `~/.agents/skills` and project
skills under `.agents/skills` from the nearest Git root down to `compute.cwd`. A deeper project
skill with the same name replaces an earlier one.

The catalog and skill documents are read live through `compute.fs`, bounded, and exposed through
model instructions plus `list_skills` and `read_skill`. The module owns no database or persistent
index. Discovery skips a malformed or unreadable skill without hiding the rest of the catalog;
`list_skills` uses its returned cursor to continue a bounded page.