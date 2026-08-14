# Native workspace

This Cargo workspace produces one small supervisor binary for Linux and macOS.
The platform-specific boundary lives below `supervisor/src/platform`; policy
parsing and direct `execve` handling are shared.
