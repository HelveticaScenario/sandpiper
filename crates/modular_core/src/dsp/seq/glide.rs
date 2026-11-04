//! Lookahead portamento for `$cycle`. A note with a glide length `g` ramps
//! its voice's CV from the held pitch to the note's pitch over the `g` cycles
//! before its onset, so the ramp lands on the beat. Positions here are in the
//! grooved clock frame, so a swung onset still lands where it sounds.

use super::cache::get_cycle_storage;
use super::seq_value::{SeqCycleStorage, SeqValue};

/// The onset sample can land a rounding error past a ramp's end, so a ramp
/// stays live this far past it.
const ONSET_SLACK: f64 = 1e-9;

const EPS: f64 = 1e-6;

/// A CV ramp into an upcoming note, claimed by one voice before the onset.
/// The onset goes to the claiming voice, which then holds the target pitch.
#[derive(Clone, Copy, Debug)]
pub(super) struct GlideRamp {
    /// Baked cycle and hap index of the target note.
    pub cycle: i64,
    pub hap_index: u32,
    pub whole_begin: f64,
    pub from: f32,
    pub target: f32,
    /// Grooved playhead at the claim.
    pub start: f64,
    /// Grooved playhead at the target onset.
    pub end: f64,
}

impl GlideRamp {
    pub fn value_at(&self, raw: f64) -> f32 {
        let span = self.end - self.start;
        let t = if span > 0.0 {
            ((raw - self.start) / span).clamp(0.0, 1.0)
        } else {
            1.0
        };
        self.from + (self.target - self.from) * t as f32
    }

    pub fn targets(&self, cycle: i64, hap_index: u32) -> bool {
        self.cycle == cycle && self.hap_index == hap_index
    }

    /// False once the playhead leaves the ramp (a scrub, or a missed onset)
    /// or the target note no longer exists in the current bake (a pattern
    /// swap).
    pub fn is_live(&self, raw: f64, base: i64, cached_haps: &[SeqCycleStorage]) -> bool {
        if raw < self.start || raw > self.end + ONSET_SLACK {
            return false;
        }
        get_cycle_storage(self.cycle, base, cached_haps)
            .and_then(|storage| storage.haps.get(self.hap_index as usize))
            .is_some_and(|hap| {
                hap.has_onset
                    && (hap.whole_begin - self.whole_begin).abs() < EPS
                    && matches!(hap.value, SeqValue::Voltage { volts, glide }
                        if glide > 0.0 && (volts as f32 - self.target).abs() < 1e-6)
            })
    }
}

/// An upcoming onset whose glide window holds the playhead.
#[derive(Clone, Copy, Debug)]
pub(super) struct OpenGlide {
    pub cycle: i64,
    pub hap_index: u32,
    pub whole_begin: f64,
    pub target: f32,
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
    pub max_glide: f64,
}

impl Lookahead<'_> {
    /// Call `visit` for every onset ahead of the playhead whose glide length
    /// reaches back to it. The scan follows the ribbon across its seam, and
    /// reaches at most one loop ahead.
    pub fn for_each_open(&self, mut visit: impl FnMut(OpenGlide)) {
        let window_end = self.offset + self.length;
        let horizon = self.pos + self.max_glide.min(self.length);
        if horizon < window_end {
            self.scan(self.pos, false, horizon, 0.0, &mut visit);
        } else {
            self.scan(self.pos, false, window_end, 0.0, &mut visit);
            self.scan(
                self.offset,
                true,
                horizon - self.length,
                self.length,
                &mut visit,
            );
        }
    }

    /// Visit the onsets in `(lo, hi]` (or `[lo, hi]` when `include_lo`), each
    /// `shift` cycles further ahead than its window position.
    fn scan(
        &self,
        lo: f64,
        include_lo: bool,
        hi: f64,
        shift: f64,
        visit: &mut impl FnMut(OpenGlide),
    ) {
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
                let SeqValue::Voltage { volts, glide } = hap.value else {
                    continue;
                };
                if !hap.has_onset
                    || glide <= 0.0
                    || hap.whole_begin < self.offset
                    || hap.whole_begin >= window_end
                {
                    continue;
                }
                let distance = hap.whole_begin + shift - self.pos;
                if distance > 0.0 && distance <= glide {
                    visit(OpenGlide {
                        cycle,
                        hap_index: hap_index as u32,
                        whole_begin: hap.whole_begin,
                        target: volts as f32,
                        distance,
                    });
                }
            }
        }
    }
}
