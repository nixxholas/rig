export function createReleaseTestEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    return {
        ...environment,
        TMPDIR: "/tmp",
    };
}
