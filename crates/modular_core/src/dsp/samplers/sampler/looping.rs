use super::{Sampler, voice::Voice};

impl Sampler {
    /// Repeat at the window edge the main voice is heading for. The next
    /// pass enters the next window exactly when the old pass reaches the
    /// edge, so the period is the window length. Around that instant they
    /// crossfade: the next pass fades in over `pre` frames of audio outside
    /// the next window's entry edge, and the old pass, as the release voice,
    /// fades out over the same frames plus `post` frames run on past its
    /// edge. The two ramps sum to unity. Each side is capped by the audio the
    /// file has there and by half of either window, so a crossfade always
    /// ends before the next seam. A next window that continues the audio the
    /// old pass leaves (the adjacent slice, or around the file end) needs no
    /// crossfade.
    pub(super) fn loop_seam(&mut self, advance: f64, frame_count: usize, max_frame: f64) {
        let (lo, hi) = (self.state.win_lo, self.state.win_hi);
        if hi <= lo || advance == 0.0 {
            return;
        }
        let (next_lo, next_hi) = self.window(frame_count, max_frame);
        let next_span = next_hi - next_lo;
        if next_span <= 0.0 {
            self.state.playing_out = true;
            self.end_loop(advance, max_frame);
            return;
        }
        let forward = advance > 0.0;
        let file_end = frame_count as f64;
        let contiguous = if forward {
            next_lo == hi || (hi == file_end && next_lo == 0.0)
        } else {
            next_hi == lo || (lo == 0.0 && next_hi == file_end)
        };
        let w = self.state.fade_frames;
        let cap = if contiguous {
            0.0
        } else {
            w.min((hi - lo).min(next_span) * 0.5)
        };
        let main = &mut self.state.main;
        let pre_room = if forward {
            next_lo
        } else {
            (max_frame - next_hi).max(0.0)
        };
        let post_room = match (forward, main.wrap_reads) {
            (_, true) => f64::INFINITY,
            (true, false) => (max_frame - hi).max(0.0),
            (false, false) => lo,
        };
        let pre = cap.min(pre_room);
        let post = (cap - pre).min(post_room);
        let xfade = pre + post;
        let p = main.position;
        let next = if forward {
            main.hi_ramp = pre;
            if p < hi - pre {
                return;
            }
            main.hi += post;
            main.hi_ramp = xfade;
            Voice {
                position: next_lo - pre + (p - (hi - pre)).rem_euclid(next_span),
                lo: next_lo - pre,
                hi: next_hi,
                lo_ramp: xfade,
                hi_ramp: w,
                wrap_reads: next_hi > max_frame,
            }
        } else {
            main.lo_ramp = pre;
            if p >= lo + pre {
                return;
            }
            main.lo -= post;
            main.lo_ramp = xfade;
            Voice {
                position: next_hi + pre - (lo + pre - p).rem_euclid(next_span),
                lo: next_lo,
                hi: next_hi + pre,
                lo_ramp: w,
                hi_ramp: xfade,
                wrap_reads: next_hi > max_frame,
            }
        };
        if xfade > 0.0 {
            self.state.rel = *main;
            self.state.rel_timed = false;
            self.state.rel_active = true;
        }
        self.state.main = next;
        self.state.win_lo = next_lo;
        self.state.win_hi = next_hi;
    }

    /// When a loop pass stops repeating, it plays out with the full fade at
    /// the edge it is heading for. Its gain on that side is unity (a seam
    /// ramp hands over to the release voice as soon as it starts),
    /// so the ramp starts at the current position at the latest; when the
    /// edge is closer than a fade width, the voice runs past it into the
    /// audio that follows, as far as the file allows.
    pub(super) fn end_loop(&mut self, advance: f64, max_frame: f64) {
        let w = self.state.fade_frames;
        let main = &mut self.state.main;
        let p = main.position;
        if advance >= 0.0 {
            let limit = if main.wrap_reads {
                f64::INFINITY
            } else {
                max_frame
            };
            let end = main.hi.max((p + w).min(limit));
            main.hi_ramp = end - (end - w).max(p);
            main.hi = end;
        } else {
            let limit = if main.wrap_reads {
                f64::NEG_INFINITY
            } else {
                0.0
            };
            let end = main.lo.min((p - w).max(limit));
            main.lo_ramp = (end + w).min(p) - end;
            main.lo = end;
        }
    }
}
