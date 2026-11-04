//! Lookahead portamento for `$cycle`. A note with a glide length `g` ramps
//! its voice's CV from the held pitch to the note's pitch over the `g` cycles
//! before its onset, so the ramp lands on the beat. Positions here are in the
//! clamped grooved clock frame, so a swung onset still lands where it sounds.

use super::cache::get_cycle_storage;
use super::seq_value::{HAP_MATCH_EPS, SeqCycleStorage, SeqValue};

/// A CV ramp into an upcoming note, claimed by one voice before the onset.
/// The onset goes to the claiming voice, which then holds the target pitch.
#[derive(Clone, Copy, Debug)]
pub(super) struct GlideRamp {
    /// Baked cycle and hap index of the target note.
    pub cycle: i64,
    pub hap_index: u32,
    pub whole_begin: f64,
    pub value: SeqValue,
    pub from: f32,
    /// Playhead at the claim.
    pub start: f64,
    /// Playhead at the target onset.
    pub end: f64,
}

impl GlideRamp {
    pub fn value_at(&self, raw: f64) -> f32 {
        let target = self.value.to_voltage().unwrap_or(0.0) as f32;
        let span = self.end - self.start;
        let t = if span > 0.0 {
            ((raw - self.start) / span).clamp(0.0, 1.0)
        } else {
            1.0
        };
        self.from + (target - self.from) * t as f32
    }

    pub fn targets(&self, cycle: i64, hap_index: u32) -> bool {
        self.cycle == cycle && self.hap_index == hap_index
    }

    /// False once the playhead leaves the ramp (a scrub, or an onset that
    /// passed without firing) or the target note no longer exists in the
    /// current bake (a pattern swap). The onset fires on the first sample at
    /// or past `end`, so the ramp stays live for `step` cycles, the playhead's
    /// movement per sample, after it.
    pub fn is_live(&self, raw: f64, step: f64, base: i64, cached_haps: &[SeqCycleStorage]) -> bool {
        if raw < self.start || raw > self.end + step {
            return false;
        }
        get_cycle_storage(self.cycle, base, cached_haps)
            .and_then(|storage| storage.haps.get(self.hap_index as usize))
            .is_some_and(|hap| {
                hap.has_onset
                    && (hap.whole_begin - self.whole_begin).abs() < HAP_MATCH_EPS
                    && hap.value.same_pitch(&self.value)
                    && hap.value.glide() > 0.0
            })
    }
}

/// A note onset ahead of the playhead.
#[derive(Clone, Copy, Debug)]
pub(super) struct Onset {
    pub cycle: i64,
    pub hap_index: u32,
    pub whole_begin: f64,
    pub value: SeqValue,
    /// Cycles from the playhead to the onset.
    pub distance: f64,
}

/// The playhead and loop window the lookahead scans from.
pub(super) struct Lookahead<'a> {
    pub cached_haps: &'a [SeqCycleStorage],
    pub base: i64,
    pub offset: f64,
    pub length: f64,
    /// Playhead in window coordinates, in `[offset, offset + length)`.
    pub pos: f64,
}

impl Lookahead<'_> {
    /// Call `visit` for every pitched onset in `(pos, pos + horizon]`. The
    /// scan follows the ribbon across its seam and reaches at most one loop
    /// ahead.
    pub fn for_each_onset(&self, horizon: f64, mut visit: impl FnMut(Onset)) {
        let window_end = self.offset + self.length;
        let reach = self.pos + horizon.min(self.length);
        if reach < window_end {
            self.scan(self.pos, false, reach, 0.0, &mut visit);
        } else {
            self.scan(self.pos, false, window_end, 0.0, &mut visit);
            self.scan(
                self.offset,
                true,
                reach - self.length,
                self.length,
                &mut visit,
            );
        }
    }

    /// Visit the onsets in `(lo, hi]` (or `[lo, hi]` when `include_lo`), each
    /// `shift` cycles further ahead than its window position.
    fn scan(&self, lo: f64, include_lo: bool, hi: f64, shift: f64, visit: &mut impl FnMut(Onset)) {
        let window_end = self.offset + self.length;
        for cycle in (lo.floor() as i64)..=(hi.floor() as i64) {
            let Some(storage) = get_cycle_storage(cycle, self.base, self.cached_haps) else {
                continue;
            };
            let haps = &storage.haps;
            let first = haps.partition_point(|h| {
                if include_lo {
                    h.part_begin < lo
                } else {
                    h.part_begin <= lo
                }
            });
            for (hap_index, hap) in haps.iter().enumerate().skip(first) {
                if hap.part_begin > hi {
                    break;
                }
                if !hap.has_onset
                    || hap.value.is_rest()
                    || hap.whole_begin < self.offset
                    || hap.whole_begin >= window_end
                {
                    continue;
                }
                visit(Onset {
                    cycle,
                    hap_index: hap_index as u32,
                    whole_begin: hap.whole_begin,
                    value: hap.value,
                    distance: hap.whole_begin + shift - self.pos,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::seq::seq_value::SeqCycleHap;

    fn bake_one_note(whole_begin: f64, value: SeqValue) -> Vec<SeqCycleStorage> {
        let mut storage = SeqCycleStorage::default();
        storage.haps.push(SeqCycleHap {
            whole_begin,
            whole_end: whole_begin + 0.5,
            part_begin: whole_begin,
            part_end: whole_begin + 0.5,
            value,
            has_onset: true,
            span_offset: 0,
            span_len: 0,
        });
        vec![storage]
    }

    #[test]
    fn ramp_stays_live_through_the_onset_sample() {
        let value = SeqValue::Voltage {
            volts: 1.0,
            glide: 0.25,
        };
        let baked = bake_one_note(0.5, value);
        let ramp = GlideRamp {
            cycle: 0,
            hap_index: 0,
            whole_begin: 0.5,
            value,
            from: 0.0,
            start: 0.25,
            end: 0.5,
        };
        let step = 1.0 / 245.1;
        assert!(ramp.is_live(0.5 + 0.9 * step, step, 0, &baked));
        assert!(!ramp.is_live(0.5 + 1.1 * step, step, 0, &baked));
        assert!(!ramp.is_live(0.2, step, 0, &baked));
        let moved = bake_one_note(0.625, value);
        assert!(!ramp.is_live(0.4, step, 0, &moved));
    }
}
