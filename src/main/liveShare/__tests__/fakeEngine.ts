import type { PatchGraph, TransportSnapshot } from '@modular/core';
import type { DSLExecuteResult } from '../../../shared/ipcTypes';
import type {
    BuiltPatch,
    PatchFailure,
    SessionEngine,
    SharedPatch,
} from '../sessionEngine';

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
    sessionOffset: number | null = null;
    startBars: number[] = [];
    applied: SharedPatch[] = [];
    stops = 0;
    private nextUpdateId = 0;

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

    /** This peer's session bar now, by its current offset. */
    sessionBar(): number | null {
        return this.sessionOffset === null
            ? null
            : Math.floor(this.transport().linkBars) + this.sessionOffset;
    }

    setLinkEnabled(enabled: boolean): void {
        this.linkEnabled = enabled;
    }

    setSessionTimeline(barOffset: number | null): void {
        this.sessionOffset = barOffset;
    }

    startAtBar(bar: number): void {
        this.startBars.push(bar);
    }

    stop(): void {
        this.stops++;
    }

    build(source: string): BuiltPatch | PatchFailure {
        if (source.includes('syntax error')) {
            return { errorMessage: 'Unexpected token' };
        }
        const patch = {
            modules: [],
            scopes: [],
            vuMeters: [],
        } as unknown as PatchGraph;
        return {
            meta: { sliders: [] },
            patch,
            video: null,
        };
    }

    apply(patch: SharedPatch): DSLExecuteResult {
        this.applied.push(patch);
        return {
            ...patch.meta,
            appliedPatch: patch.patch,
            success: true,
            updateId: ++this.nextUpdateId,
        };
    }
}
