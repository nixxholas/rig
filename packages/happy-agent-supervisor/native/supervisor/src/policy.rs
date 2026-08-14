use crate::proxy::MAX_TOKEN_BYTES;
use crate::{SupervisorResult, invalid_input};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    Auto,
    FullAccess,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyFrontEnd {
    Http,
    Socks5,
}

/// Host-side TLS termination, which the supervisor requests but never performs.
///
/// The supervisor holds no TLS stack and no private key. Its whole contribution is pointing the
/// workload's certificate trust at the file the host wrote, so a caller that never asked for
/// termination never has a certificate authority injected into its environment.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TlsTerminationPolicy {
    pub(crate) certificate_authority_file: PathBuf,
}

/// The pre-connected link to the host proxy, plus the front-ends to expose over it.
///
/// One descriptor carries every stream. It is connected by Rig before the sandbox exists, so
/// nothing inside the sandbox ever reaches the proxy — or anything else — by address.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct OutgoingProxyPolicy {
    pub(crate) upstream_fd: i32,
    pub(crate) token: String,
    pub(crate) front_ends: Vec<ProxyFrontEnd>,
    #[serde(default)]
    pub(crate) tls_termination: Option<TlsTerminationPolicy>,
}

impl OutgoingProxyPolicy {
    pub(crate) fn exposes(&self, front_end: ProxyFrontEnd) -> bool {
        self.front_ends.contains(&front_end)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NetworkPolicy {
    pub(crate) egress: bool,
    #[serde(default)]
    pub(crate) allowed_hosts: Vec<String>,
    pub(crate) local_binding: bool,
    #[serde(default)]
    pub(crate) outgoing_proxy: Option<OutgoingProxyPolicy>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SupervisorPolicy {
    pub(crate) mode: PermissionMode,
    #[serde(default)]
    pub(crate) allowed_read_paths: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) denied_read_paths: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) allowed_write_paths: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) denied_write_paths: Vec<PathBuf>,
    pub(crate) network: NetworkPolicy,
}

impl SupervisorPolicy {
    pub(crate) fn validate(&self) -> SupervisorResult<()> {
        for path in self
            .allowed_read_paths
            .iter()
            .chain(&self.denied_read_paths)
            .chain(&self.allowed_write_paths)
            .chain(&self.denied_write_paths)
        {
            validate_absolute_path(path)?;
        }
        if self.network.allowed_hosts.iter().any(String::is_empty) {
            return Err(invalid_input("network.allowedHosts cannot contain an empty host").into());
        }
        if self.mode == PermissionMode::FullAccess {
            let mut restrictions = Vec::new();
            if !self.denied_read_paths.is_empty() {
                restrictions.push("deniedReadPaths");
            }
            if !self.denied_write_paths.is_empty() {
                restrictions.push("deniedWritePaths");
            }
            if !self.network.allowed_hosts.is_empty() {
                restrictions.push("network.allowedHosts");
            }
            if !self.network.egress {
                restrictions.push("network.egress");
            }
            if !self.network.local_binding {
                restrictions.push("network.localBinding");
            }
            if self.network.outgoing_proxy.is_some() {
                restrictions.push("network.outgoingProxy");
            }
            if !restrictions.is_empty() {
                return Err(invalid_input(format!(
                    "full_access cannot be combined with restrictions: {}",
                    restrictions.join(", ")
                ))
                .into());
            }
        }
        // The supervisor cannot enforce a host list itself: it never resolves a name and never
        // opens a socket to a destination. The list is enforced by the host proxy that owns the
        // token, so naming hosts without that proxy still has to fail closed.
        if self.network.egress
            && !self.network.allowed_hosts.is_empty()
            && self.network.outgoing_proxy.is_none()
        {
            return Err(invalid_input(
                "network.allowedHosts requires network.outgoingProxy, which is where a host list is enforced",
            )
            .into());
        }
        if let Some(proxy) = &self.network.outgoing_proxy {
            validate_outgoing_proxy(proxy, self.network.egress)?;
        }
        Ok(())
    }

    pub(crate) fn writable_roots(&self, cwd: &Path) -> Vec<PathBuf> {
        let mut roots = self.allowed_write_paths.clone();
        if matches!(
            self.mode,
            PermissionMode::WorkspaceWrite | PermissionMode::Auto
        ) {
            roots.push(cwd.to_path_buf());
        }
        deduplicate_paths(roots)
    }
}

fn validate_outgoing_proxy(proxy: &OutgoingProxyPolicy, egress: bool) -> SupervisorResult<()> {
    if !egress {
        return Err(invalid_input(
            "network.outgoingProxy requires network.egress, because the proxy is how egress happens",
        )
        .into());
    }
    if proxy.upstream_fd <= libc::STDERR_FILENO {
        return Err(
            invalid_input("network.outgoingProxy.upstreamFd must be greater than 2").into(),
        );
    }
    if proxy.token.is_empty() || proxy.token.len() > MAX_TOKEN_BYTES {
        return Err(invalid_input(format!(
            "network.outgoingProxy.token must be between 1 and {MAX_TOKEN_BYTES} bytes"
        ))
        .into());
    }
    if proxy.front_ends.is_empty() {
        return Err(invalid_input(
            "network.outgoingProxy.frontEnds must name at least one front-end",
        )
        .into());
    }
    if let Some(tls) = &proxy.tls_termination {
        validate_absolute_path(&tls.certificate_authority_file)?;
    }
    Ok(())
}

fn validate_absolute_path(path: &Path) -> SupervisorResult<()> {
    if !path.is_absolute() {
        return Err(invalid_input(format!(
            "supervisor policy paths must be absolute: {}",
            path.display()
        ))
        .into());
    }
    Ok(())
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in paths {
        if !result.iter().any(|existing| existing == &path) {
            result.push(path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{PermissionMode, ProxyFrontEnd, SupervisorPolicy};

    #[test]
    fn parses_compute_permission_names() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "deniedWritePaths": ["/workspace/.git"],
                "network": {"egress": true, "localBinding": false}
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));

        assert_eq!(policy.mode, PermissionMode::WorkspaceWrite);
        assert_eq!(
            policy.denied_write_paths[0].to_string_lossy(),
            "/workspace/.git"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        let result = serde_json::from_str::<SupervisorPolicy>(
            r#"{
                "mode": "auto",
                "shell": "sh -lc",
                "network": {"egress": false, "localBinding": false}
            }"#,
        );
        assert!(result.is_err());
    }

    #[test]
    fn host_allowlists_fail_closed_only_when_egress_is_enabled() {
        let blocked: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": false,
                    "allowedHosts": ["example.com"],
                    "localBinding": false
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("blocked policy should parse: {error}"));
        blocked
            .validate()
            .unwrap_or_else(|error| panic!("disabled egress enforces every host list: {error}"));

        let managed: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": true,
                    "allowedHosts": ["example.com"],
                    "localBinding": false
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("managed policy should parse: {error}"));
        let error = managed
            .validate()
            .err()
            .unwrap_or_else(|| panic!("egress allowlist without a proxy should fail closed"));
        assert!(error.to_string().contains("network.outgoingProxy"));
    }

    #[test]
    fn host_allowlists_are_accepted_once_a_proxy_owns_them() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": true,
                    "allowedHosts": ["example.com"],
                    "localBinding": false,
                    "outgoingProxy": {
                        "upstreamFd": 3,
                        "token": "abc",
                        "frontEnds": ["http", "socks5"]
                    }
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("proxy policy should parse: {error}"));
        policy
            .validate()
            .unwrap_or_else(|error| panic!("proxy policy should validate: {error}"));

        let proxy = policy
            .network
            .outgoing_proxy
            .unwrap_or_else(|| panic!("proxy section should be present"));
        assert_eq!(proxy.upstream_fd, 3);
        assert!(proxy.exposes(ProxyFrontEnd::Http));
        assert!(proxy.exposes(ProxyFrontEnd::Socks5));
        assert!(proxy.tls_termination.is_none());
    }

    #[test]
    fn proxy_policies_fail_closed_on_unusable_input() {
        let cases = [
            (
                r#"{"upstreamFd": 2, "token": "abc", "frontEnds": ["http"]}"#,
                "upstreamFd",
            ),
            (
                r#"{"upstreamFd": 3, "token": "", "frontEnds": ["http"]}"#,
                "token",
            ),
            (r#"{"upstreamFd": 3, "token": "abc", "frontEnds": []}"#, "frontEnds"),
            (
                r#"{"upstreamFd": 3, "token": "abc", "frontEnds": ["http"], "tlsTermination": {"certificateAuthorityFile": "relative.pem"}}"#,
                "absolute",
            ),
        ];
        for (proxy, expected) in cases {
            let policy: SupervisorPolicy = serde_json::from_str(&format!(
                r#"{{
                    "mode": "workspace_write",
                    "network": {{"egress": true, "localBinding": false, "outgoingProxy": {proxy}}}
                }}"#
            ))
            .unwrap_or_else(|error| panic!("policy should parse ({proxy}): {error}"));
            let error = policy
                .validate()
                .err()
                .unwrap_or_else(|| panic!("policy should fail closed: {proxy}"));
            assert!(
                error.to_string().contains(expected),
                "expected {expected} in {error}"
            );
        }
    }

    #[test]
    fn a_proxy_without_egress_is_refused() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": false,
                    "localBinding": false,
                    "outgoingProxy": {"upstreamFd": 3, "token": "abc", "frontEnds": ["http"]}
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));
        let error = policy
            .validate()
            .err()
            .unwrap_or_else(|| panic!("a proxy without egress should fail closed"));
        assert!(error.to_string().contains("network.egress"));
    }

    #[test]
    fn full_access_cannot_carry_a_proxy() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "full_access",
                "network": {
                    "egress": true,
                    "localBinding": true,
                    "outgoingProxy": {"upstreamFd": 3, "token": "abc", "frontEnds": ["http"]}
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));
        let error = policy
            .validate()
            .err()
            .unwrap_or_else(|| panic!("full access should reject a proxy"));
        assert!(error.to_string().contains("network.outgoingProxy"));
    }
}
