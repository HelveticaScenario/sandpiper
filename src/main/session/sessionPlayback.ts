import { randomUUID } from 'crypto';
import * as Y from 'yjs';
import type { PatchGraph } from '@modular/core';
import type { SessionPeer } from '../../shared/session';
import {
    type SessionTimelineState,
    barBeatsOf,
    barOf,
    isTimelineState,
    nextTargetBar,
    scheduleEvaluation,
    segmentAt,
} from '../../shared/sessionTimeline';
import { ClockSync, type ClockMesh } from './clockSync';

/** Transaction origin of this module's own writes to the document. */
const PLAYBACK_ORIGIN = 'playback';

/** How long a missing reference is tolerated before another peer takes over. */
const REFERENCE_GRACE_MS = 4000;

/**
 * Time an evaluation needs to reach every peer before it plays, on top of
 * the time peers take to build it. Evaluations play on the first whole bar
 * at least that far ahead.
 */
const EVAL_HEADROOM_MICROS = 400_000;

/** An evaluation every peer plays, as the session document stores it. */
export interface SessionEval {
    id: string;
    /** Id of the shared file the source came from. */
    fileId: string;
    source: string;
    /** Session bar the patch takes over on. */
    atBar: number;
    /** Session bar the song's bar count started on. */
    originBar: number;
    author: SessionPeer;
}

export interface SessionClockConfig {
    offsetMicros: number;
    timeline: SessionTimelineState['timeline'];
    pending?: SessionTimelineState['timeline'];
}

export interface PlaybackHost {
    /** The engine's host clock, in microseconds. */
    hostMicros: () => number;
    setSessionClock: (config: SessionClockConfig | null) => void;
    /** Tempo and meter the engine plays now, for a new session's timeline. */
    currentMeter: () => { bpm: number; barBeats: number };
    /**
     * Build the patch from a peer's source and play it on `atBar`; false if
     * it could not be built here (an asset still arriving, say).
     */
    playRemote: (evaluation: SessionEval) => boolean;
}

/** Plan for playing a local evaluation of a shared file to the session. */
export interface LocalEvalPlan {
    fileId: string;
    sourceId: string;
    atBar: number;
    originBar: number;
}

/** The source id the engine reconciles against for a shared file. */
export function sessionSourceId(fileId: string): string {
    return `session:${fileId}`;
}

function isSessionEval(value: unknown): value is SessionEval {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const e = value as Record<string, unknown>;
    const author = e.author as Record<string, unknown> | undefined;
    return (
        typeof e.id === 'string' &&
        typeof e.fileId === 'string' &&
        typeof e.source === 'string' &&
        Number.isInteger(e.atBar) &&
        Number.isInteger(e.originBar) &&
        typeof author?.id === 'string' &&
        typeof author.name === 'string' &&
        typeof author.color === 'string'
    );
}

/**
 * Keeps every peer playing the same patch on the same bar. One shared
 * timeline maps session time to bars; an evaluation of a shared file is
 * written to the document with the bar it plays on, and every peer builds the
 * patch from the same source and swaps it in on that bar.
 *
 * The document's `playback` map holds the clock reference peer, the timeline
 * and the latest evaluation. Concurrent evaluations resolve to the same
 * winner everywhere, as any Yjs map entry does.
 */
export class SessionPlayback {
    readonly clock: ClockSync;
    private readonly doc: Y.Doc;
    private readonly host: PlaybackHost;
    private readonly self: SessionPeer;
    private readonly map: Y.Map<unknown>;
    private readonly startedAt = Date.now();
    private referenceMissingSince: number | null = null;
    private readonly electionTimer: NodeJS.Timeout;
    /** A peer's evaluation waiting for this peer to sync its clock. */
    private waitingEval: SessionEval | null = null;
    private lastPlayedEvalId: string | null = null;
    /** The latest peer evaluation, if it failed to build here. */
    private failedEval: SessionEval | null = null;
    private disposed = false;
    private readonly observer = (event: Y.YMapEvent<unknown>) => {
        if (event.keysChanged.has('reference')) {
            this.clock.setReference(this.reference());
        }
        if (event.keysChanged.has('timeline')) {
            this.configureEngine();
        }
        if (event.keysChanged.has('current') && !event.transaction.local) {
            this.receive(this.map.get('current'));
        }
    };

    constructor(
        doc: Y.Doc,
        mesh: ClockMesh,
        self: SessionPeer,
        role: 'host' | 'guest',
        host: PlaybackHost,
    ) {
        this.doc = doc;
        this.host = host;
        this.self = self;
        this.map = doc.getMap('playback');
        this.clock = new ClockSync({ mesh, now: host.hostMicros });
        this.clock.on('offset', () => {
            this.ensureTimeline();
            this.configureEngine();
            const waiting = this.waitingEval;
            if (waiting && this.clock.isSynced()) {
                this.waitingEval = null;
                this.play(waiting);
            }
        });
        this.clock.on('presence', () => this.electReference());
        this.map.observe(this.observer);
        if (role === 'host' && !this.map.has('reference')) {
            doc.transact(() => this.map.set('reference', self.id), PLAYBACK_ORIGIN);
        }
        this.clock.setReference(this.reference());
        this.electionTimer = setInterval(() => this.electReference(), 1000);
        // A guest joining a running session plays what is already playing.
        this.receive(this.map.get('current'));
    }

    dispose(): void {
        this.disposed = true;
        clearInterval(this.electionTimer);
        this.map.unobserve(this.observer);
        this.clock.stop();
        this.host.setSessionClock(null);
    }

    timelineState(): SessionTimelineState | null {
        const value = this.map.get('timeline');
        return isTimelineState(value) ? value : null;
    }

    /** The session bar now, or null before this peer is in sync. */
    currentBar(): number | null {
        const now = this.clock.sessionNow();
        const state = this.timelineState();
        return now === null || !state ? null : barOf(state, now);
    }

    /** Whether this peer can play evaluations to the session yet. */
    isReady(): boolean {
        return this.clock.isSynced() && this.timelineState() !== null;
    }

    /**
     * Plan to play a local evaluation of the shared file `fileId` to the
     * session, or null when this peer cannot yet (not in sync, no timeline).
     * `buildMicros` is how long building the patch took here; other peers
     * take about as long again, so the target bar leaves room for it.
     */
    planLocal(fileId: string, buildMicros = 0): LocalEvalPlan | null {
        const now = this.clock.sessionNow();
        const state = this.timelineState();
        if (now === null || !state) {
            return null;
        }
        const atBar = nextTargetBar(
            state,
            now,
            EVAL_HEADROOM_MICROS + 2 * Math.max(0, buildMicros),
        );
        const current = this.map.get('current');
        const previous = isSessionEval(current) ? current : null;
        // A different file starts a new song; its bar count starts here.
        const originBar =
            previous && previous.fileId === fileId ? previous.originBar : atBar;
        return { atBar, fileId, originBar, sourceId: sessionSourceId(fileId) };
    }

    /**
     * Tell the session about a local evaluation that is already queued in
     * this peer's engine, so every other peer plays it on the same bar.
     */
    publishLocal(plan: LocalEvalPlan, source: string, patch: PatchGraph): void {
        const now = this.clock.sessionNow();
        const state = this.timelineState();
        if (now === null || !state) {
            return;
        }
        const evaluation: SessionEval = {
            atBar: plan.atBar,
            author: this.self,
            fileId: plan.fileId,
            id: randomUUID(),
            originBar: plan.originBar,
            source,
        };
        const next = scheduleEvaluation(
            state,
            now,
            plan.atBar,
            meterChange(patch, segmentAt(state, now).bpm),
        );
        this.lastPlayedEvalId = evaluation.id;
        this.doc.transact(() => {
            this.map.set('timeline', next);
            this.map.set('current', evaluation);
        }, PLAYBACK_ORIGIN);
    }

    private reference(): string | null {
        const value = this.map.get('reference');
        return typeof value === 'string' ? value : null;
    }

    /**
     * When the reference has been gone a while, the present peer with the
     * smallest id takes over, keeping its own idea of session time.
     */
    private electReference(): void {
        if (this.disposed) {
            return;
        }
        const present = this.clock.presentPeers();
        const reference = this.reference();
        if (reference && present.has(reference)) {
            this.referenceMissingSince = null;
            return;
        }
        const now = Date.now();
        if (!reference && now - this.startedAt < REFERENCE_GRACE_MS) {
            return;
        }
        this.referenceMissingSince ??= now;
        if (now - this.referenceMissingSince < REFERENCE_GRACE_MS) {
            return;
        }
        // A peer in sync carries session time on unbroken; if none is, the
        // timeline has lost its time base and a new one starts.
        const synced = [...present].filter((id) =>
            id === this.self.id ? this.clock.isSynced() : this.clock.isPeerSynced(id),
        );
        const candidates = synced.length > 0 ? synced : [...present];
        const smallest = candidates.sort()[0];
        if (smallest === this.self.id) {
            this.referenceMissingSince = null;
            this.doc.transact(() => {
                this.map.set('reference', this.self.id);
                if (synced.length === 0) {
                    this.map.delete('timeline');
                }
            }, PLAYBACK_ORIGIN);
            this.ensureTimeline();
        }
    }

    /** The reference starts the timeline when the session has none. */
    private ensureTimeline(): void {
        const now = this.clock.sessionNow();
        if (
            now === null ||
            this.reference() !== this.self.id ||
            this.timelineState()
        ) {
            return;
        }
        const { bpm, barBeats } = this.host.currentMeter();
        const state: SessionTimelineState = {
            timeline: { anchorBar: 0, anchorMicros: Math.round(now), barBeats, bpm },
        };
        this.doc.transact(() => this.map.set('timeline', state), PLAYBACK_ORIGIN);
    }

    private configureEngine(): void {
        if (this.disposed) {
            return;
        }
        const offset = this.clock.getOffset();
        const state = this.timelineState();
        if (offset === null || !state) {
            this.host.setSessionClock(null);
            return;
        }
        this.host.setSessionClock({
            offsetMicros: Math.round(offset),
            pending: state.pending,
            timeline: state.timeline,
        });
    }

    private receive(value: unknown): void {
        if (!isSessionEval(value) || value.id === this.lastPlayedEvalId) {
            return;
        }
        if (!this.clock.isSynced() || !this.timelineState()) {
            this.waitingEval = value;
            return;
        }
        this.play(value);
    }

    private play(evaluation: SessionEval): void {
        if (this.disposed || evaluation.id === this.lastPlayedEvalId) {
            return;
        }
        this.lastPlayedEvalId = evaluation.id;
        // Building a patch can take a while; it runs after the document
        // transaction that delivered it has finished.
        setImmediate(() => {
            if (!this.disposed) {
                this.attempt(evaluation);
            }
        });
    }

    /**
     * Try the latest peer evaluation again if it failed here, once whatever
     * it was missing may have arrived. It plays on the next bar, counting
     * bars from its song's start as everyone else does.
     */
    retryFailed(): void {
        const failed = this.failedEval;
        const current = this.map.get('current');
        if (
            !failed ||
            this.disposed ||
            !isSessionEval(current) ||
            current.id !== failed.id
        ) {
            return;
        }
        this.attempt(failed);
    }

    private attempt(evaluation: SessionEval): void {
        let played = false;
        try {
            played = this.host.playRemote(evaluation);
        } catch (error) {
            console.warn('[session] could not play a peer evaluation', error);
        }
        this.failedEval = played ? null : evaluation;
    }
}

/**
 * The tempo and meter a patch asks for. The tempo counts only when the patch
 * sets one; otherwise the timeline keeps `currentBpm`.
 */
export function meterChange(
    patch: PatchGraph,
    currentBpm: number,
): { bpm: number; barBeats: number } | null {
    const clock = patch.modules.find((m) => m.id === 'ROOT_CLOCK');
    if (!clock) {
        return null;
    }
    const params = clock.params as Record<string, unknown>;
    const tempo = typeof params.tempo === 'number' ? params.tempo : currentBpm;
    const numerator = typeof params.numerator === 'number' ? params.numerator : 4;
    const denominator =
        typeof params.denominator === 'number' ? params.denominator : 4;
    return {
        barBeats: barBeatsOf(numerator, denominator),
        bpm: params.tempoSet === true ? tempo : currentBpm,
    };
}
