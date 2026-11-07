/**
 * The host's authority over what a session plays and when.
 *
 * Every run, from any peer, is built once on the host and sent to every peer
 * as a `SharedPatch` naming the session bar it applies on. The first run of a
 * stopped session starts playback on a bar; later runs apply on the next bar
 * boundary. Bars are chosen with enough lead that the patch reaches every
 * peer before its bar begins.
 */
import type { QueuedTrigger } from '@modular/core';
import { isBufferSwitch } from '../bufferSwitch';
import type { PlaybackState } from './protocol';
import {
    isBuiltPatch,
    type PatchFailure,
    type SessionEngine,
    type SharedPatch,
} from './sessionEngine';

/** Bars between a patch leaving the host and its bar beginning, at least. */
export const PATCH_LEAD_BARS = 0.15;

/** The first bar boundary at least `PATCH_LEAD_BARS` after `sessionBars`. */
export function nextSharedBar(sessionBars: number): number {
    const next = Math.floor(sessionBars) + 1;
    return next - sessionBars >= PATCH_LEAD_BARS ? next : next + 1;
}

export interface RunRequest {
    authorId: string;
    requestId: string | null;
    source: string;
    sourceId: string | null;
    trigger: QueuedTrigger | null;
}

export class HostPlayback {
    private seq = 0;
    private playing = false;
    private songOrigin = 0;
    private current: SharedPatch | null = null;

    constructor(
        private readonly engine: SessionEngine,
        /** The host's session position in bars, now. */
        private readonly sessionBars: () => number,
    ) {}

    state(): PlaybackState {
        return {
            patch: this.current,
            playing: this.playing,
            songOrigin: this.songOrigin,
        };
    }

    /**
     * Build a run into the patch every peer applies, or the failure to report
     * to its author. Every run applies on a shared bar, so a requested
     * Immediate or NextBeat trigger plays on the next bar.
     */
    run(request: RunRequest): SharedPatch | PatchFailure {
        const built = this.engine.build(request.source);
        if (!isBuiltPatch(built)) {
            return built;
        }
        const bar = nextSharedBar(this.sessionBars());
        const starting = !this.playing;
        const resetClock =
            !starting &&
            isBufferSwitch(this.current?.sourceId ?? null, request.sourceId);
        if (starting || resetClock) {
            this.songOrigin = bar;
        }
        this.playing = true;
        this.current = {
            ...built,
            atBar: starting ? null : bar,
            authorId: request.authorId,
            requestId: request.requestId,
            resetClock,
            seq: ++this.seq,
            sourceId: request.sourceId,
            startBar: starting ? bar : null,
        };
        return this.current;
    }

    stop(): void {
        this.playing = false;
        this.current = null;
    }
}

/**
 * Apply a shared patch to this peer's engine: arm its start first when it
 * starts playback.
 */
export function applySharedPatch(engine: SessionEngine, patch: SharedPatch) {
    if (patch.startBar !== null) {
        engine.startAtBar(patch.startBar);
    }
    return engine.apply(patch);
}

/**
 * Bring a peer whose clock just came into sync up to the session's playback:
 * start on the song's origin bar (already passed, so it joins mid-song) with
 * the current patch applied at once.
 */
export function joinPlayback(engine: SessionEngine, playback: PlaybackState) {
    if (!playback.playing || !playback.patch) {
        engine.stop();
        return null;
    }
    engine.startAtBar(playback.songOrigin);
    return engine.apply({
        ...playback.patch,
        atBar: null,
        resetClock: false,
        startBar: null,
    });
}
