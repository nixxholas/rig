use crate::policy::SupervisorPolicy;
use crate::{SupervisorResult, invalid_input};
use std::ffi::OsString;

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod child;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

pub(crate) fn run(policy: SupervisorPolicy, command: Vec<OsString>) -> SupervisorResult<()> {
    #[cfg(target_os = "linux")]
    {
        return linux::run(policy, command);
    }
    #[cfg(target_os = "macos")]
    {
        return macos::run(policy, command);
    }
    #[allow(unreachable_code)]
    Err(invalid_input("happy-agent-supervisor supports only Linux and macOS").into())
}
