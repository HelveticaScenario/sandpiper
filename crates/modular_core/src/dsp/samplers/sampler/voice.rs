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
        self.gain_f64(fade) as f32
    }

    fn gain_f64(&self, fade: f64) -> f64 {
        let ramp = |d: f64, r: Ramp| {
            let r = r.width(fade);
            if r > 0.0 {
                (d / r).clamp(0.0, 1.0)
            } else {
                1.0
            }
        };
        ramp(self.position - self.lo, self.lo_ramp).min(ramp(self.hi - self.position, self.hi_ramp))
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

    /// Fade out from the current gain to silence `fade` frames from the
    /// current position in either direction, so a speed change can't
    /// prolong it. Toward the edge the voice is heading for, the fade runs
    /// on past that edge as far as the file allows; with `bounded`, the
    /// voice still ends at the edge if it comes first.
    pub(super) fn fade_out(&mut self, forward: bool, fade: f64, max_frame: f64, bounded: bool) {
        let p = self.position;
        let g = self.gain_f64(fade);
        let (lo_limit, hi_limit) = if self.wrap_reads {
            (f64::NEG_INFINITY, f64::INFINITY)
        } else {
            (0.0, max_frame)
        };
        let run_on = !bounded;
        let hi = (p + fade).min(if run_on && forward { hi_limit } else { self.hi });
        let lo = (p - fade).max(if run_on && !forward {
            lo_limit
        } else {
            self.lo
        });
        // A silent voice stays silent: an infinite ramp holds its gain at 0.
        let ramp = |len: f64| {
            Ramp::Frames(if g > 0.0 {
                len.max(0.0) / g
            } else {
                f64::INFINITY
            })
        };
        self.hi_ramp = ramp(hi - p);
        self.lo_ramp = ramp(p - lo);
        self.hi = hi.max(p);
        self.lo = lo.min(p);
    }
}

/// Release voices sounding at once. The gate can fall during a loop seam's
/// crossfade, so a seam release and a gate release can overlap.
pub(super) const RELEASE_SLOTS: usize = 2;

/// A previous pass that keeps sounding at a fading gain after the gate falls
/// or a loop seam, so neither the stop nor the jump to a new pass clicks.
#[derive(Clone, Copy, Default)]
pub(super) struct Release {
    pub(super) voice: Voice,
    pub(super) active: bool,
    /// Set once the voice stops or turns back: it then also ramps down over
    /// `fade_out_samples`, which bounds the ring-out to the fade time
    /// regardless of speed. Until then it fades by its span ramp alone: a
    /// seam release's mirrors the new pass's fade-in so the two sum to unity,
    /// and a gate release's ends `fade` frames from where the gate fell.
    timed: bool,
    countdown: u32,
    /// Ceiling on the span gain. A release whose voice stops or turns back
    /// becomes timed and never rises above the gain it had then.
    ceiling: f32,
    /// This sample's gain.
    level: f32,
    /// The direction the voice was moving when released (±1).
    heading: f64,
}

impl Release {
    pub(super) fn new(voice: Voice, heading: f64) -> Self {
        Self {
            voice,
            active: true,
            timed: false,
            countdown: 0,
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
        if !self.timed && by * self.heading <= 0.0 {
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
