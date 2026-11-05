use crate::types::{hermite_clamped, hermite_wrapped};

/// A declick ramp's width: the module's current fade, so a `fade` change
/// reaches a voice already playing, or a fixed number of WAV frames.
#[derive(Clone, Copy, Default)]
pub(super) enum Ramp {
    #[default]
    Fade,
    Frames(f64),
}

impl Ramp {
    fn width(self, fade: f64) -> f64 {
        match self {
            Ramp::Fade => fade,
            Ramp::Frames(frames) => frames,
        }
    }
}

/// One playback head: a position, the span it may sound in, and a declick
/// ramp at each end of that span.
#[derive(Clone, Copy, Default)]
pub(super) struct Voice {
    pub(super) position: f64,
    /// The voice ends once its position leaves `[lo, hi]`.
    pub(super) lo: f64,
    pub(super) hi: f64,
    /// Gain rises linearly from 0 at an edge to 1 this far inside it.
    /// Position-based, so the ramps are symmetric under reverse and fade
    /// time scales with |speed|; a zero width is a hard edge.
    pub(super) lo_ramp: Ramp,
    pub(super) hi_ramp: Ramp,
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
    pub(super) fn gain(&self, fade: f64) -> f32 {
        let ramp = |d: f64, r: Ramp| {
            let r = r.width(fade);
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
            hermite_wrapped(samples, self.position)
        } else {
            hermite_clamped(samples, self.position)
        }
    }

    /// Fade out over `fade` frames at the edge the voice is heading for,
    /// starting at the current position at the latest. When the edge is
    /// closer than that, the span runs on past it into the audio that
    /// follows, as far as the file allows. The voice's gain on that side
    /// must be unity, as it is for a held loop pass.
    pub(super) fn play_out(&mut self, forward: bool, fade: f64, max_frame: f64) {
        let p = self.position;
        if forward {
            let limit = if self.wrap_reads {
                f64::INFINITY
            } else {
                max_frame
            };
            let end = self.hi.max((p + fade).min(limit));
            self.hi_ramp = Ramp::Frames(end - (end - fade).max(p));
            self.hi = end;
        } else {
            let limit = if self.wrap_reads {
                f64::NEG_INFINITY
            } else {
                0.0
            };
            let end = self.lo.min((p - fade).max(limit));
            self.lo_ramp = Ramp::Frames((end + fade).min(p) - end);
            self.lo = end;
        }
    }
}

/// Release voices sounding at once. A retrigger can land during a loop
/// seam's crossfade, so a seam and a retrigger release can overlap.
pub(super) const RELEASE_SLOTS: usize = 2;

/// A previous pass that keeps sounding at a fading gain after a retrigger
/// or a loop seam, so the jump to the new pass doesn't click.
#[derive(Clone, Copy, Default)]
pub(super) struct Release {
    pub(super) voice: Voice,
    pub(super) active: bool,
    /// Also ramps down over `fade_out_samples`, which bounds the ring-out to
    /// the fade time regardless of speed. A seam release fades by its span
    /// ramp alone, which mirrors the new pass's fade-in so the two sum to
    /// unity.
    timed: bool,
    countdown: u32,
    /// Ceiling on the span gain. A seam release whose voice turns back
    /// toward its window becomes timed and never rises above the gain it
    /// had when it turned.
    ceiling: f32,
    /// This sample's gain.
    level: f32,
    /// The direction the voice was moving when released (±1).
    heading: f64,
}

impl Release {
    pub(super) fn new(voice: Voice, timed: bool, fade_out_samples: u32, heading: f64) -> Self {
        Self {
            voice,
            active: true,
            timed,
            countdown: fade_out_samples,
            ceiling: 1.0,
            level: 1.0,
            heading: heading.signum(),
        }
    }

    /// The release's gain this sample; it deactivates once spent.
    pub(super) fn gain(&mut self, fade: f64, fade_out_samples: u32) -> f32 {
        if !self.active {
            return 0.0;
        }
        if (self.timed && self.countdown == 0) || !self.voice.in_span() {
            self.active = false;
            self.level = 0.0;
            return 0.0;
        }
        // Clamped because a patch update can shrink fade_out_samples
        // mid-release.
        let t = if self.timed {
            (self.countdown as f64 / fade_out_samples.max(1) as f64).min(1.0) as f32
        } else {
            1.0
        };
        self.level = self.voice.gain(fade).min(self.ceiling) * t;
        self.level
    }

    pub(super) fn advance(&mut self, by: f64, fade_out_samples: u32) {
        if !self.active {
            return;
        }
        if !self.timed && by * self.heading < 0.0 {
            self.timed = true;
            self.countdown = fade_out_samples;
            self.ceiling = self.level;
        }
        self.voice.position += by;
        if self.timed {
            self.countdown = self.countdown.saturating_sub(1);
        }
    }
}

/// Start a release in a free slot, or in place of the quietest one.
pub(super) fn push_release(slots: &mut [Release; RELEASE_SLOTS], release: Release) {
    let slot = slots
        .iter_mut()
        .min_by(|a, b| {
            let level = |r: &Release| if r.active { r.level } else { -1.0 };
            level(a).total_cmp(&level(b))
        })
        .expect("RELEASE_SLOTS is nonzero");
    *slot = release;
}
