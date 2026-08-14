export const MANAGED_NETWORK_SOCAT_PREFLIGHT =
    'command -v socat >/dev/null 2>&1 || { echo "Managed network access requires socat on PATH. Install socat and retry." >&2; exit 127; }';
