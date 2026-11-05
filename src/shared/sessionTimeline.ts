/**
 * The bar timeline a live session plays to. Session time is in microseconds;
 * the bar position at time t on a segment is
 * `anchorBar + (t - anchorMicros) * bpm / 60e6 / barBeats`, the same mapping
 * the engine's session clock uses.
 */

export interface TimelineSegment {
    anchorMicros: number;
    anchorBar: number;
    /** Quarter notes per minute. */
    bpm: number;
    /** Quarter notes per bar. */
    barBeats: number;
}

/**
 * The timeline as the session document stores it: the segment in force and,
 * optionally, the next one, which takes over at its anchor (always a bar
 * boundary of the segment before it, so the bar position never jumps).
 */
export interface SessionTimelineState {
    timeline: TimelineSegment;
    pending?: TimelineSegment;
}

const MICROS_PER_MINUTE = 60e6;

export function barAt(segment: TimelineSegment, micros: number): number {
    return (
        segment.anchorBar +
        ((micros - segment.anchorMicros) * segment.bpm) /
            MICROS_PER_MINUTE /
            segment.barBeats
    );
}

export function microsAtBar(segment: TimelineSegment, bar: number): number {
    return (
        segment.anchorMicros +
        ((bar - segment.anchorBar) * segment.barBeats * MICROS_PER_MINUTE) /
            segment.bpm
    );
}

/** The segment in force at `micros`. */
export function segmentAt(
    state: SessionTimelineState,
    micros: number,
): TimelineSegment {
    return state.pending && micros >= state.pending.anchorMicros
        ? state.pending
        : state.timeline;
}

export function barOf(state: SessionTimelineState, micros: number): number {
    return barAt(segmentAt(state, micros), micros);
}

/** Quarter notes per bar for a time signature. */
export function barBeatsOf(numerator: number, denominator: number): number {
    return (Math.max(1, numerator) * 4) / Math.max(1, denominator);
}

/**
 * The first whole bar at least `headroomMicros` after `now`, so peers have
 * time to receive an evaluation before it plays.
 */
export function nextTargetBar(
    state: SessionTimelineState,
    now: number,
    headroomMicros: number,
): number {
    return Math.ceil(barOf(state, now + headroomMicros) - 1e-9);
}

/**
 * The timeline after an evaluation that plays at `targetBar`. A newer
 * evaluation supersedes one still waiting, so a pending segment that has not
 * started yet is dropped; one already in force becomes the timeline. When the
 * evaluation sets a tempo or meter different from the one in force at the
 * target bar, a segment starting exactly at that bar is scheduled.
 */
export function scheduleEvaluation(
    state: SessionTimelineState,
    now: number,
    targetBar: number,
    change: { bpm: number; barBeats: number } | null,
): SessionTimelineState {
    const base = segmentAt(state, now);
    if (
        !change ||
        !(change.bpm > 0) ||
        !(change.barBeats > 0) ||
        (change.bpm === base.bpm && change.barBeats === base.barBeats)
    ) {
        return { timeline: base };
    }
    return {
        pending: {
            anchorBar: targetBar,
            anchorMicros: microsAtBar(base, targetBar),
            barBeats: change.barBeats,
            bpm: change.bpm,
        },
        timeline: base,
    };
}

/** Whether a value read from the document is a usable timeline state. */
export function isTimelineState(value: unknown): value is SessionTimelineState {
    const isSegment = (s: unknown): s is TimelineSegment => {
        if (typeof s !== 'object' || s === null) {
            return false;
        }
        const seg = s as Record<string, unknown>;
        return (
            Number.isFinite(seg.anchorMicros) &&
            Number.isFinite(seg.anchorBar) &&
            typeof seg.bpm === 'number' &&
            seg.bpm > 0 &&
            typeof seg.barBeats === 'number' &&
            seg.barBeats > 0
        );
    };
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const state = value as Record<string, unknown>;
    return (
        isSegment(state.timeline) &&
        (state.pending === undefined || isSegment(state.pending))
    );
}
