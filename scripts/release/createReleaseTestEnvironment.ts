export function createReleaseTestEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const testEnvironment = { ...environment };
    delete testEnvironment.TMPDIR;
    return testEnvironment;
}
