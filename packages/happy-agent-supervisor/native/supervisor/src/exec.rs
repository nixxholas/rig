use crate::{SupervisorResult, invalid_input};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::os::raw::c_char;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub(crate) fn exec_target(
    command: &[OsString],
    environment_overrides: &[EnvironmentOverride],
) -> SupervisorResult<()> {
    let executable = resolve_executable(&command[0])?;
    let executable = c_string(executable.as_os_str(), "target executable")?;
    let arguments = command
        .iter()
        .map(|argument| c_string(argument, "target argument"))
        .collect::<SupervisorResult<Vec<_>>>()?;
    let environment = merge_environment(environment_overrides)
        .into_iter()
        .map(|(key, value)| {
            let mut entry = key;
            entry.push("=");
            entry.push(value);
            c_string(&entry, "environment entry")
        })
        .collect::<SupervisorResult<Vec<_>>>()?;
    let argument_pointers = nul_terminated_pointers(&arguments);
    let environment_pointers = nul_terminated_pointers(&environment);

    unsafe {
        libc::execve(
            executable.as_ptr(),
            argument_pointers.as_ptr(),
            environment_pointers.as_ptr(),
        );
    }
    Err(std::io::Error::last_os_error().into())
}

/// One inherited variable the supervisor replaces, or removes when it has no value to give.
pub(crate) type EnvironmentOverride = (OsString, Option<OsString>);

/// Applies the supervisor's own variables over the inherited environment.
///
/// An override with no value removes the variable outright. That is what keeps an inherited
/// proxy address or exemption list from surviving into a workload whose policy never named it.
fn merge_environment(overrides: &[EnvironmentOverride]) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| !overrides.iter().any(|(name, _)| name == key))
        .collect();
    for (name, value) in overrides {
        if let Some(value) = value {
            environment.push((name.clone(), value.clone()));
        }
    }
    environment
}

fn resolve_executable(command: &OsStr) -> SupervisorResult<PathBuf> {
    if command.as_bytes().contains(&b'/') {
        return Ok(PathBuf::from(command));
    }
    let path = std::env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
    for directory in std::env::split_paths(&path) {
        let directory = if directory.as_os_str().is_empty() {
            Path::new(".")
        } else {
            directory.as_path()
        };
        let candidate = directory.join(command);
        let candidate_c = match CString::new(candidate.as_os_str().as_bytes()) {
            Ok(candidate) => candidate,
            Err(_) => continue,
        };
        if unsafe { libc::access(candidate_c.as_ptr(), libc::X_OK) } == 0 {
            return Ok(candidate);
        }
    }
    Err(invalid_input(format!(
        "target executable was not found after the sandbox was established: {}",
        command.to_string_lossy()
    ))
    .into())
}

fn c_string(value: &OsStr, description: &str) -> SupervisorResult<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| invalid_input(format!("{description} contains a NUL byte")).into())
}

fn nul_terminated_pointers(values: &[CString]) -> Vec<*const c_char> {
    let mut pointers = values
        .iter()
        .map(CString::as_c_str)
        .map(CStr::as_ptr)
        .collect::<Vec<_>>();
    pointers.push(std::ptr::null());
    pointers
}
