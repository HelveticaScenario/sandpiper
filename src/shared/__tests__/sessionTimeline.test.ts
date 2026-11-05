import { describe, expect, it } from 'vitest';
import {
    type SessionTimelineState,
    type TimelineSegment,
    barAt,
    barBeatsOf,
    barOf,
    isTimelineState,
    microsAtBar,
    nextTargetBar,
    scheduleEvaluation,
} from '../sessionTimeline';

// 120 bpm in 4/4: one bar every two seconds.
const base: TimelineSegment = {
    anchorBar: 10,
    anchorMicros: 1_000_000,
    barBeats: 4,
    bpm: 120,
};

describe('session timeline', () => {
    it('maps time to bars and back', () => {
        expect(barAt(base, 1_000_000)).toBe(10);
        expect(barAt(base, 3_000_000)).toBe(11);
        expect(barAt(base, 2_000_000)).toBe(10.5);
        expect(microsAtBar(base, 12)).toBe(5_000_000);
        expect(barAt(base, microsAtBar(base, 37.25))).toBeCloseTo(37.25, 9);
    });

    it('follows a pending segment from its anchor on', () => {
        const state: SessionTimelineState = {
            pending: { anchorBar: 12, anchorMicros: 5_000_000, barBeats: 3, bpm: 90 },
            timeline: base,
        };
        expect(barOf(state, 4_000_000)).toBe(11.5);
        // 90 bpm in 3/4 is a bar every two seconds too, from bar 12.
        expect(barOf(state, 7_000_000)).toBe(13);
    });

    it('computes quarter notes per bar from a time signature', () => {
        expect(barBeatsOf(4, 4)).toBe(4);
        expect(barBeatsOf(6, 8)).toBe(3);
        expect(barBeatsOf(7, 4)).toBe(7);
        expect(barBeatsOf(0, 0)).toBe(4);
    });

    it('targets the first whole bar past the headroom', () => {
        const state = { timeline: base };
        // At bar 10.5 with 0.4 s headroom: bar 10.7 → plays on 11.
        expect(nextTargetBar(state, 2_000_000, 400_000)).toBe(11);
        // Too close to bar 11: 10.9 + 0.2 → plays on 12.
        expect(nextTargetBar(state, 2_800_000, 400_000)).toBe(12);
        // Exactly on a boundary after the headroom plays on that bar.
        expect(nextTargetBar(state, 2_600_000, 400_000)).toBe(11);
    });
});

describe('scheduleEvaluation', () => {
    const state: SessionTimelineState = { timeline: base };

    it('keeps the timeline when the tempo and meter do not change', () => {
        expect(
            scheduleEvaluation(state, 2_000_000, 11, { barBeats: 4, bpm: 120 }),
        ).toEqual({ timeline: base });
        expect(scheduleEvaluation(state, 2_000_000, 11, null)).toEqual({
            timeline: base,
        });
    });

    it('schedules a phase-continuous segment on the target bar', () => {
        const next = scheduleEvaluation(state, 2_000_000, 11, {
            barBeats: 4,
            bpm: 140,
        });
        expect(next.timeline).toEqual(base);
        expect(next.pending).toEqual({
            anchorBar: 11,
            anchorMicros: 3_000_000,
            barBeats: 4,
            bpm: 140,
        });
        // Bar 11 lands at the same instant before and after the switch.
        expect(barOf(next, 3_000_000)).toBe(11);
    });

    it('drops a pending change that a newer evaluation supersedes', () => {
        const waiting = scheduleEvaluation(state, 2_000_000, 11, {
            barBeats: 4,
            bpm: 140,
        });
        expect(scheduleEvaluation(waiting, 2_100_000, 11, null)).toEqual({
            timeline: base,
        });
    });

    it('keeps a change already in force as the new base', () => {
        const waiting = scheduleEvaluation(state, 2_000_000, 11, {
            barBeats: 4,
            bpm: 140,
        });
        const later = scheduleEvaluation(waiting, 3_500_000, 12, null);
        expect(later).toEqual({ timeline: waiting.pending });
    });

    it('ignores nonsense tempos', () => {
        expect(
            scheduleEvaluation(state, 2_000_000, 11, { barBeats: 4, bpm: 0 }),
        ).toEqual({ timeline: base });
        expect(
            scheduleEvaluation(state, 2_000_000, 11, { barBeats: 4, bpm: NaN }),
        ).toEqual({ timeline: base });
    });
});

describe('isTimelineState', () => {
    it('accepts valid states and rejects malformed ones from peers', () => {
        expect(isTimelineState({ timeline: base })).toBe(true);
        expect(isTimelineState({ pending: base, timeline: base })).toBe(true);
        expect(isTimelineState(null)).toBe(false);
        expect(isTimelineState({ timeline: { ...base, bpm: -1 } })).toBe(false);
        expect(isTimelineState({ timeline: { ...base, anchorBar: 'x' } })).toBe(
            false,
        );
        expect(isTimelineState({ pending: {}, timeline: base })).toBe(false);
    });
});
