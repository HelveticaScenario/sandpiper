/**
 * The audio engine as a live share session drives it. The app implements
 * this over the native synthesizer; tests implement it with fakes.
 */
import type { TransportSnapshot } from '@modular/core';

export interface SessionEngine {
    transport(): TransportSnapshot;
    setLinkEnabled(enabled: boolean): void;
}

/** How long to wait for the audio thread's first Link reading. */
const LINK_START_TIMEOUT_MS = 2_000;

/**
 * Enable Link and wait until the audio thread reports a Link position, so
 * the session's bar numbers start from a real reading.
 */
export async function startLink(engine: SessionEngine): Promise<void> {
    engine.setLinkEnabled(true);
    const before = engine.transport().linkBars;
    const deadline = Date.now() + LINK_START_TIMEOUT_MS;
    while (engine.transport().linkBars === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
