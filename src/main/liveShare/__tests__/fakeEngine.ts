import type { TransportSnapshot } from '@modular/core';
import type { SessionEngine } from '../sessionEngine';

/** One bar at 120 BPM in 4/4. */
export const BAR_MS = 2_000;

/**
 * A stand-in for one peer's engine. Every fake shares one Link phase (bars
 * since `epoch`), offset by a whole number of bars per peer, as real peers'
 * Link timelines are.
 */
export class FakeEngine implements SessionEngine {
    linkEnabled = false;
    linkPeers = 1;

    constructor(
        private readonly epoch: number,
        private readonly linkOrigin: number,
    ) {}

    transport(): TransportSnapshot {
        return {
            bar: 0,
            barPhase: 0,
            beatInBar: 0,
            bpm: 120,
            hasQueuedUpdate: false,
            isPlaying: false,
            lastAppliedUpdateId: 0,
            lastCancelledUpdateId: 0,
            linkBars: this.linkEnabled
                ? this.linkOrigin + (Date.now() - this.epoch) / BAR_MS
                : 0,
            linkEnabled: this.linkEnabled,
            linkPendingStart: false,
            linkPeers: this.linkPeers,
            linkPhase: 0,
            timeSigDenominator: 4,
            timeSigNumerator: 4,
        };
    }

    setLinkEnabled(enabled: boolean): void {
        this.linkEnabled = enabled;
    }
}
