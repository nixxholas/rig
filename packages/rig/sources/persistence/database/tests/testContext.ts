import { createTestRootContext } from "../../../testing/createTestRootContext.js";

export function testContext() {
    return createTestRootContext().named("database-test");
}
