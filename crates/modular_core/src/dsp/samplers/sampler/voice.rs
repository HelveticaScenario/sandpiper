use crate::types::{hermite_clamped, hermite_wrapped};

/// One playback head: a position, the span it may sound in, and a declick
/// ramp at each end of that span.
#[derive(Clone, Copy, Default)]
pub(super) struct Voice {
    pub(super) position: f64,
    /// The voice ends once its position leaves `[lo, hi]`.
    pub(super) lo: f64,
    pub(super) hi: f64,
    /// Gain rises linearly from 0 at an edge to 1 this many frames inside
    /// it. Position-based, so the ramps are symmetric under reverse and
    /// fade time scales with |speed|; 0 is a hard edge.
    pub(super) lo_ramp: f64,
    pub(super) hi_ramp: f64,
    /// Reads wrap around the file end, so the last frame runs on into the
    /// first. Set for loops whose window reaches the end of the file.
    pub(super) wrap_reads: bool,
}

impl Voice {
    /// NaN comparisons are false, so a non-finite position counts as
    /// outside — a voice can always end.
    pub(super) fn in_span(&self) -> bool {
        self.position >= self.lo && self.position <= self.hi
    }

    /// Spans shorter than their two ramps peak below unity.
    pub(super) fn gain(&self) -> f32 {
        let ramp = |d: f64, r: f64| {
            if r > 0.0 {
                (d / r).clamp(0.0, 1.0)
            } else {
                1.0
            }
        };
        ramp(self.position - self.lo, self.lo_ramp).min(ramp(self.hi - self.position, self.hi_ramp))
            as f32
    }

    /// Reads one channel's samples at the voice position.
    pub(super) fn read(&self, samples: &[f32]) -> f32 {
        if self.wrap_reads {
            hermite_wrapped(samples, self.position as f32)
        } else {
            hermite_clamped(samples, self.position as f32)
        }
    }
}
