/** Formats a compute lifecycle duration without exposing raw millisecond values. */
export function formatComputeDuration(milliseconds: number): string {
    const roundedMilliseconds = Math.max(0, Math.round(milliseconds));
    if (roundedMilliseconds < 1_000) {
        return `${String(roundedMilliseconds)} ${
            roundedMilliseconds === 1 ? "millisecond" : "milliseconds"
        }`;
    }

    const totalSeconds = Math.max(1, Math.round(roundedMilliseconds / 1_000));
    if (totalSeconds < 60) {
        return `${String(totalSeconds)} ${totalSeconds === 1 ? "second" : "seconds"}`;
    }

    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60) {
        return joinDuration(
            totalMinutes,
            totalMinutes === 1 ? "minute" : "minutes",
            seconds,
            seconds === 1 ? "second" : "seconds",
        );
    }

    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (totalHours < 24) {
        return joinDuration(
            totalHours,
            totalHours === 1 ? "hour" : "hours",
            minutes,
            minutes === 1 ? "minute" : "minutes",
        );
    }

    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return joinDuration(days, days === 1 ? "day" : "days", hours, hours === 1 ? "hour" : "hours");
}

function joinDuration(major: number, majorUnit: string, minor: number, minorUnit: string): string {
    const majorText = `${String(major)} ${majorUnit}`;
    return minor === 0 ? majorText : `${majorText} ${String(minor)} ${minorUnit}`;
}
