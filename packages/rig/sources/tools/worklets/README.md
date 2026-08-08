# Worklet tools

Common agent tools for installing, updating, reverting, uninstalling, listing, and reading logs
from worklets. Every provider receives this same fixed tool surface.

Mutating tools disclose and review the external source, persisted code, background runtime, and
declared network boundary before delegating to `WorkletContext`.
