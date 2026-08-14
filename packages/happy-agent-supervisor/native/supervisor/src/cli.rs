use crate::policy::SupervisorPolicy;
use crate::{SupervisorResult, invalid_input};
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Take};
use std::os::fd::FromRawFd;
use std::path::PathBuf;

const MAX_POLICY_BYTES: u64 = 1024 * 1024;

pub(crate) struct Invocation {
    pub(crate) policy: SupervisorPolicy,
    pub(crate) command: Vec<OsString>,
}

enum PolicySource {
    Descriptor(i32),
    File(PathBuf),
}

impl Invocation {
    pub(crate) fn parse() -> SupervisorResult<Self> {
        let mut arguments = std::env::args_os();
        let _program = arguments.next();
        let mut policy_source = None;
        let mut command = Vec::new();

        while let Some(argument) = arguments.next() {
            if argument == "--" {
                command.extend(arguments);
                break;
            }
            if argument == "--policy-fd" {
                let raw = arguments
                    .next()
                    .ok_or_else(|| invalid_input("--policy-fd requires a descriptor number"))?;
                let raw = raw
                    .to_str()
                    .ok_or_else(|| invalid_input("policy descriptor must be valid UTF-8"))?;
                let descriptor = raw
                    .parse::<i32>()
                    .map_err(|_| invalid_input("policy descriptor must be an integer"))?;
                if descriptor <= libc::STDERR_FILENO {
                    return Err(invalid_input("policy descriptor must be greater than 2").into());
                }
                set_policy_source(&mut policy_source, PolicySource::Descriptor(descriptor))?;
                continue;
            }
            if argument == "--policy-file" {
                let path = arguments
                    .next()
                    .ok_or_else(|| invalid_input("--policy-file requires a path"))?;
                set_policy_source(&mut policy_source, PolicySource::File(PathBuf::from(path)))?;
                continue;
            }
            return Err(invalid_input(format!(
                "unknown supervisor argument before --: {}",
                argument.to_string_lossy()
            ))
            .into());
        }

        if command.is_empty() {
            return Err(invalid_input("a target command is required after --").into());
        }
        let source = policy_source.ok_or_else(|| {
            invalid_input("exactly one of --policy-fd or --policy-file is required")
        })?;
        let policy = read_policy(source)?;
        Ok(Self { policy, command })
    }
}

fn set_policy_source(
    current: &mut Option<PolicySource>,
    source: PolicySource,
) -> SupervisorResult<()> {
    if current.is_some() {
        return Err(invalid_input("policy transport may be specified only once").into());
    }
    *current = Some(source);
    Ok(())
}

fn read_policy(source: PolicySource) -> SupervisorResult<SupervisorPolicy> {
    let file = match source {
        PolicySource::Descriptor(descriptor) => {
            // The invocation contract transfers ownership of the descriptor to the supervisor.
            unsafe { File::from_raw_fd(descriptor) }
        }
        PolicySource::File(path) => File::open(path)?,
    };
    let mut bytes = Vec::new();
    let mut limited: Take<File> = file.take(MAX_POLICY_BYTES + 1);
    limited.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_POLICY_BYTES {
        return Err(invalid_input("policy JSON exceeds the 1 MiB limit").into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}
