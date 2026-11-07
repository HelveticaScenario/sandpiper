/** Resolve once `condition` holds, polling every 10 ms. */
export function waitFor(
    condition: () => boolean,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = (): void => {
            if (condition()) {
                resolve();
            } else if (Date.now() > deadline) {
                reject(new Error('Timed out waiting for condition'));
            } else {
                setTimeout(poll, 10);
            }
        };
        poll();
    });
}
