import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read the machine's real Rig configuration. A developer who keeps a global
// AGENTS.md or happy.toml would otherwise change the behaviour of agents under test, so a suite
// that passes on a clean checkout fails on theirs. Point every test at an empty directory instead.
process.env.RIG_CONFIGURATION_DIRECTORY = mkdtempSync(join(tmpdir(), "rig-test-configuration-"));
