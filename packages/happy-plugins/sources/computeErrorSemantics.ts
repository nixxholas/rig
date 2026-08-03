import type { HappyComputeError, HappyComputeErrorCode } from "./computeTypes.js";

export function happyComputeErrorStatus(
    code: HappyComputeErrorCode,
): 400 | 404 | 409 | 429 | 502 | 503 | 504 {
    switch (code) {
        case "provider_not_found":
        case "instance_not_found":
            return 404;
        case "invalid_request":
            return 400;
        case "capacity_exhausted":
            return 429;
        case "preparing_compute":
            return 409;
        case "invalid_response":
            return 502;
        case "provider_lost":
        case "provider_unhealthy":
            return 503;
        case "deadline_exceeded":
            return 504;
        case "instance_failed":
            return 409;
    }
}

export function normalizeHappyComputeError(error: HappyComputeError): HappyComputeError {
    switch (error.code) {
        case "capacity_exhausted":
            return {
                code: error.code,
                message: error.message,
                retryable: true,
                ...(error.state === undefined ? {} : { state: error.state }),
            };
        case "deadline_exceeded":
            return {
                code: error.code,
                message: error.message,
                retryable: true,
                ...(error.state === undefined ? {} : { state: error.state }),
            };
        case "preparing_compute":
            return error;
        case "instance_failed":
        case "instance_not_found":
        case "invalid_request":
        case "invalid_response":
        case "provider_lost":
        case "provider_not_found":
        case "provider_unhealthy":
            return {
                code: error.code,
                message: error.message,
                retryable: false,
                ...(error.state === undefined ? {} : { state: error.state }),
            };
    }
}
