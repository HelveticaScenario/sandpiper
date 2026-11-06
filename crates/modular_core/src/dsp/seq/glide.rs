//! Lookahead portamento for `$cycle`. A note with a glide length `g` ramps
//! its voice's CV from the held pitch to the note's pitch over the `g` cycles
//! before its onset, so the ramp lands on the beat. Window positions share
//! the playhead's grooved frame, so a swung onset still lands where it sounds.
//!
//! The bake lists where each glide window opens. The audio thread notes each
//! window the playhead enters as pending, and claims a voice for it once one
//! is free at the onset.

use arrayvec::ArrayVec;

use super::cache::get_cycle_storage;
use super::seq_value::{HAP_MATCH_EPS, SeqCycleStorage, SeqValue};
use crate::poly::PORT_MAX_CHANNELS;

/// A gliding note's window in the baked ribbon window.
#[derive(Clone, Copy, Debug)]
struct GlideWindow {
    /// Window position where the ramp may start, in `[offset, offset + length)`.
    open: f64,
    cycle: i64,
    hap_index: u32,
    whole_begin: f64,
    value: SeqValue,
    /// Glide length in cycles, at most one loop.
    glide: f64,
}

/// The glide windows and onsets of one bake, each sorted by window position.
#[derive(Debug, Default)]
pub(crate) struct GlideBake {
    onsets: Vec<f64>,
    windows: Vec<GlideWindow>,
    /// Longest window, in cycles. A window holding the playhead opened at
    /// most this far behind it.
    max_glide: f64,
}

impl GlideBake {
    pub(crate) fn new(cached_haps: &[SeqCycleStorage], offset: f64, length: f64) -> Self {
        let end = offset + length;
        let base = offset.floor() as i64;
        let mut bake = Self::default();
        for (i, storage) in cached_haps.iter().enumerate() {
            for (hap_index, hap) in storage.haps.iter().enumerate() {
                if !hap.has_onset
                    || hap.value.is_rest()
                    || hap.whole_begin < offset
                    || hap.whole_begin >= end
                {
                    continue;
                }
                bake.onsets.push(hap.whole_begin);
                let glide = hap.value.glide().min(length);
                if glide <= 0.0 {
                    continue;
                }
                bake.max_glide = bake.max_glide.max(glide);
                let open = offset + (hap.whole_begin - glide - offset).rem_euclid(length);
                bake.windows.push(GlideWindow {
                    open: if open < end { open } else { offset },
                    cycle: base + i as i64,
                    hap_index: hap_index as u32,
                    whole_begin: hap.whole_begin,
                    value: hap.value,
                    glide,
                });
            }
        }
        bake.onsets.sort_by(f64::total_cmp);
        bake.windows.sort_by(|a, b| a.open.total_cmp(&b.open));
        bake
    }

    fn is_empty(&self) -> bool {
        self.windows.is_empty()
    }

    /// Onsets at window positions in `(lo, hi]`, where `lo` is in the window
    /// and `hi < lo + length`.
    fn onsets_between(&self, lo: f64, hi: f64, offset: f64, length: f64) -> usize {
        let after = |x: f64| self.onsets.partition_point(|&p| p <= x);
        if hi < offset + length {
            after(hi) - after(lo)
        } else {
            self.onsets.len() - after(lo) + after(hi - length)
        }
    }
}

/// An upcoming note a ramp can land on.
#[derive(Clone, Copy, Debug)]
pub(super) struct GlideTarget {
    /// Baked cycle and hap index of the note.
    pub cycle: i64,
    pub hap_index: u32,
    pub whole_begin: f64,
    pub value: SeqValue,
    /// Playhead at the onset.
    pub onset: f64,
}

impl GlideTarget {
    fn is(&self, cycle: i64, hap_index: u32) -> bool {
        self.cycle == cycle && self.hap_index == hap_index
    }
}

/// A CV ramp into an upcoming note, claimed by one voice before the onset.
/// The onset goes to the claiming voice, which then holds the target pitch.
#[derive(Clone, Copy, Debug)]
pub(super) struct GlideRamp {
    pub target: GlideTarget,
    pub from: f32,
    /// Playhead at the claim.
    pub start: f64,
}

impl GlideRamp {
    pub fn value_at(&self, raw: f64) -> f32 {
        let target = self.target.value.to_voltage().unwrap_or(0.0) as f32;
        let span = self.target.onset - self.start;
        let t = if span > 0.0 {
            ((raw - self.start) / span).clamp(0.0, 1.0)
        } else {
            1.0
        };
        self.from + (target - self.from) * self.target.value.ease().apply(t as f32)
    }

    pub fn targets(&self, cycle: i64, hap_index: u32) -> bool {
        self.target.is(cycle, hap_index)
    }

    /// False once the playhead leaves the ramp: a scrub, or an onset that
    /// passed without firing. The onset fires on the first sample at or past
    /// it, so the ramp stays live for `step` cycles, the playhead's movement
    /// per sample, after it.
    pub fn in_range(&self, raw: f64, step: f64) -> bool {
        raw >= self.start && raw <= self.target.onset + step
    }

    /// True while the target note still exists, and glides, in this bake.
    pub fn target_exists(&self, base: i64, cached_haps: &[SeqCycleStorage]) -> bool {
        get_cycle_storage(self.target.cycle, base, cached_haps)
            .and_then(|storage| storage.haps.get(self.target.hap_index as usize))
            .is_some_and(|hap| {
                hap.has_onset
                    && (hap.whole_begin - self.target.whole_begin).abs() < HAP_MATCH_EPS
                    && hap.value.same_pitch(&self.target.value)
                    && hap.value.glide() > 0.0
            })
    }
}

/// The voice-facing view a claim needs of one channel.
pub(super) trait GlideVoice {
    fn ramp(&self) -> Option<&GlideRamp>;
    /// True when the voice is idle, or its note ends, by `onset`.
    fn free_by(&self, onset: f64) -> bool;
    fn held_cv(&self) -> f32;
    fn claim(&mut self, ramp: GlideRamp);
}

/// The playhead for one sample.
pub(super) struct Playhead {
    /// Grooved clock position, clamped at zero.
    pub raw: f64,
    /// `raw` folded into the window, in `[offset, offset + length)`.
    pub pos: f64,
    /// `pos` on the previous sample.
    pub prev_pos: f64,
    /// The playhead crossed the ribbon seam since the previous sample.
    pub lap_wrapped: bool,
    pub offset: f64,
    pub length: f64,
}

impl Playhead {
    /// The target of the window's note when the playhead is inside the window.
    fn target_in(&self, window: &GlideWindow) -> Option<GlideTarget> {
        let mut distance = window.whole_begin - self.pos;
        if distance <= 0.0 {
            distance += self.length;
        }
        (distance <= window.glide + HAP_MATCH_EPS).then_some(GlideTarget {
            cycle: window.cycle,
            hap_index: window.hap_index,
            whole_begin: window.whole_begin,
            value: window.value,
            onset: self.raw + distance,
        })
    }
}

/// Glide windows the playhead is inside whose notes no voice has claimed.
#[derive(Default)]
pub(super) struct GlideTracker {
    /// Rebuild `pending` from the bake on the next sample.
    pub rescan: bool,
    pending: ArrayVec<GlideTarget, PORT_MAX_CHANNELS>,
    /// `pending` dropped a window while full. The dropped window has a full
    /// list of unclaimed onsets before it, so it cannot claim a voice until
    /// `pending` has room again, which triggers a rescan.
    overflowed: bool,
}

impl GlideTracker {
    /// Hold `target` until a voice claims it, keeping the earliest onsets.
    pub fn push(&mut self, target: GlideTarget) {
        if self
            .pending
            .iter()
            .any(|p| p.is(target.cycle, target.hap_index))
        {
            return;
        }
        if !self.pending.is_full() {
            self.pending.push(target);
            return;
        }
        self.overflowed = true;
        if let Some(latest) = self
            .pending
            .iter_mut()
            .max_by(|a, b| a.onset.total_cmp(&b.onset))
            && target.onset < latest.onset
        {
            *latest = target;
        }
    }

    /// Track the windows the playhead entered since `prev_pos`, then claim
    /// voices for pending windows when they or the voices changed. `rescan`
    /// asks for a full rebuild, needed after a non-forward step.
    pub fn advance<V: GlideVoice>(
        &mut self,
        bake: &GlideBake,
        playhead: &Playhead,
        mut rescan: bool,
        voices: &mut [V],
        voices_changed: bool,
    ) {
        rescan |= std::mem::take(&mut self.rescan);
        if bake.is_empty() {
            self.pending.clear();
            self.overflowed = false;
            return;
        }
        let raw = playhead.raw;
        self.pending.retain(|p| raw < p.onset - HAP_MATCH_EPS);
        rescan |= self.overflowed && !self.pending.is_full();

        let claimed = |voices: &[V], window: &GlideWindow| {
            voices.iter().any(|v| {
                v.ramp()
                    .is_some_and(|r| r.targets(window.cycle, window.hap_index))
            })
        };
        let after = |x: f64| bake.windows.partition_point(|w| w.open <= x);
        let all = bake.windows.len();
        let ranges = if rescan {
            self.pending.clear();
            self.overflowed = false;
            let lo = playhead.pos - bake.max_glide;
            let from = |x: f64| bake.windows.partition_point(|w| w.open < x);
            if bake.max_glide >= playhead.length {
                [0..all, 0..0]
            } else if lo >= playhead.offset {
                [from(lo)..after(playhead.pos), 0..0]
            } else {
                [from(lo + playhead.length)..all, 0..after(playhead.pos)]
            }
        } else if playhead.lap_wrapped {
            [after(playhead.prev_pos)..all, 0..after(playhead.pos)]
        } else {
            let from = after(playhead.prev_pos);
            [from..after(playhead.pos).max(from), 0..0]
        };
        let mut entered = rescan;
        for range in ranges {
            for window in &bake.windows[range] {
                if !claimed(voices, window)
                    && let Some(target) = playhead.target_in(window)
                {
                    self.push(target);
                    entered = true;
                }
            }
        }

        if self.pending.is_empty() || !(entered || voices_changed) {
            return;
        }
        self.pending
            .sort_unstable_by(|a, b| a.onset.total_cmp(&b.onset));
        self.pending
            .retain(|target| !claim(bake, playhead, voices, *target));
    }
}

/// Give `target` to the nearest-pitched voice free at its onset, unless the
/// unclaimed onsets before it need every such voice. True when claimed.
fn claim<V: GlideVoice>(
    bake: &GlideBake,
    playhead: &Playhead,
    voices: &mut [V],
    target: GlideTarget,
) -> bool {
    let free_at_onset = |v: &V| v.ramp().is_none() && v.free_by(target.onset + HAP_MATCH_EPS);
    let free = voices.iter().filter(|v| free_at_onset(v)).count();
    let ahead = target.onset - playhead.raw - HAP_MATCH_EPS;
    let claimed_earlier = voices
        .iter()
        .filter(|v| {
            v.ramp()
                .is_some_and(|r| r.target.onset - playhead.raw < ahead)
        })
        .count();
    let earlier = bake
        .onsets_between(
            playhead.pos,
            playhead.pos + ahead,
            playhead.offset,
            playhead.length,
        )
        .saturating_sub(claimed_earlier);
    if free <= earlier {
        return false;
    }
    let pitch = target.value.to_voltage().unwrap_or(0.0) as f32;
    let nearest = (0..voices.len())
        .filter(|&i| free_at_onset(&voices[i]))
        .min_by(|&a, &b| {
            (voices[a].held_cv() - pitch)
                .abs()
                .total_cmp(&(voices[b].held_cv() - pitch).abs())
        });
    let Some(i) = nearest else {
        return false;
    };
    let from = voices[i].held_cv();
    voices[i].claim(GlideRamp {
        target,
        from,
        start: playhead.raw,
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::seq::seq_value::SeqCycleHap;

    fn bake_notes(notes: &[(f64, SeqValue)]) -> Vec<SeqCycleStorage> {
        let mut storage = SeqCycleStorage::default();
        for &(whole_begin, value) in notes {
            storage.haps.push(SeqCycleHap {
                whole_begin,
                whole_end: whole_begin + 0.25,
                part_begin: whole_begin,
                part_end: whole_begin + 0.25,
                value,
                has_onset: true,
                span_offset: 0,
                span_len: 0,
            });
        }
        vec![storage]
    }

    fn gliding(volts: f64, glide: f64) -> SeqValue {
        SeqValue::Voltage {
            volts,
            glide,
            ease: Default::default(),
        }
    }

    #[test]
    fn ramp_stays_live_through_the_onset_sample() {
        let value = gliding(1.0, 0.25);
        let baked = bake_notes(&[(0.5, value)]);
        let ramp = GlideRamp {
            target: GlideTarget {
                cycle: 0,
                hap_index: 0,
                whole_begin: 0.5,
                value,
                onset: 0.5,
            },
            from: 0.0,
            start: 0.25,
        };
        let step = 1.0 / 245.1;
        assert!(ramp.in_range(0.5 + 0.9 * step, step));
        assert!(!ramp.in_range(0.5 + 1.1 * step, step));
        assert!(!ramp.in_range(0.2, step));
        assert!(ramp.target_exists(0, &baked));
        assert!(!ramp.target_exists(0, &bake_notes(&[(0.625, value)])));
    }

    #[test]
    fn windows_open_before_their_onsets_across_the_seam() {
        let baked = bake_notes(&[(0.0, gliding(0.0, 0.25)), (0.5, gliding(1.0, 2.0))]);
        let bake = GlideBake::new(&baked, 0.0, 1.0);
        let opens: Vec<f64> = bake.windows.iter().map(|w| w.open).collect();
        // A glide longer than the loop opens one loop ahead, on the onset.
        assert_eq!(opens, vec![0.5, 0.75]);
        assert_eq!(bake.onsets, vec![0.0, 0.5]);
        assert_eq!(bake.max_glide, 1.0);
        assert_eq!(bake.onsets_between(0.5, 1.25, 0.0, 1.0), 1);
        assert_eq!(bake.onsets_between(0.0, 0.5, 0.0, 1.0), 1);
    }
}
