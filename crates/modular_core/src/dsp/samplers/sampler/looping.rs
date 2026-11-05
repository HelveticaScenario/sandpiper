use super::{
    Sampler,
    voice::{Ramp, Release, Voice, push_release},
};

impl Sampler {
    /// Repeat at the window edge the main voice is heading for. The next
    /// pass enters the next window exactly when the old pass reaches the
    /// edge, so the period is the window length. Around that instant they
    /// crossfade: the next pass fades in over `pre` frames of audio outside
    /// the next window's entry edge, and the old pass, as a release voice,
    /// fades out over the same frames plus `post` frames run on past its
    /// edge. The two ramps sum to unity. Each side is capped by the audio the
    /// file has there and by half of either window, so a crossfade always
    /// ends before the next seam. A next window that continues the audio the
    /// old pass leaves (the adjacent slice, or around the file end) needs no
    /// crossfade.
    ///
    /// The next window is picked once, when the pass comes within the
    /// crossfade's reach of its edge (a fade width, or half the window), and
    /// held until the seam. An empty pick plays the pass out instead.
    pub(super) fn loop_seam(&mut self, advance: f64, frame_count: usize, max_frame: f64) {
        let (lo, hi) = (self.state.win_lo, self.state.win_hi);
        if hi <= lo || advance == 0.0 {
            return;
        }
        let forward = advance > 0.0;
        let w = self.state.fade_frames;
        let p = self.state.main.position;
        // A pass that turns back while in a seam's pre-roll is already past
        // the edge it now heads for; it fades out by its own ramp and the
        // held gate starts a fresh pass.
        let behind = if forward {
            p - advance > hi
        } else {
            p - advance < lo
        };
        if behind {
            return;
        }
        let reach = w.min((hi - lo) * 0.5);
        if (forward && p < hi - reach) || (!forward && p >= lo + reach) {
            self.state.next_win = None;
            return;
        }
        let (next_lo, next_hi) = match self.state.next_win {
            Some(win) => win,
            None => {
                let win = self.window(frame_count, max_frame);
                self.state.next_win = Some(win);
                win
            }
        };
        let next_span = next_hi - next_lo;
        if next_span <= 0.0 {
            self.end_loop(advance, max_frame);
            return;
        }
        let file_end = frame_count as f64;
        let contiguous = if forward {
            next_lo == hi || (hi == file_end && next_lo == 0.0)
        } else {
            next_hi == lo || (lo == 0.0 && next_hi == file_end)
        };
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
        let next = if forward {
            main.hi_ramp = Ramp::Frames(pre);
            if p < hi - pre {
                return;
            }
            main.hi += post;
            main.hi_ramp = Ramp::Frames(xfade);
            Voice {
                position: next_lo - pre + (p - (hi - pre)).rem_euclid(next_span),
                lo: next_lo - pre,
                hi: next_hi,
                lo_ramp: Ramp::Frames(xfade),
                hi_ramp: Ramp::Frames(0.0),
                wrap_reads: next_hi > max_frame,
            }
        } else {
            main.lo_ramp = Ramp::Frames(pre);
            if p >= lo + pre {
                return;
            }
            main.lo -= post;
            main.lo_ramp = Ramp::Frames(xfade);
            Voice {
                position: next_hi + pre - (lo + pre - p).rem_euclid(next_span),
                lo: next_lo,
                hi: next_hi + pre,
                lo_ramp: Ramp::Frames(0.0),
                hi_ramp: Ramp::Frames(xfade),
                wrap_reads: next_hi > max_frame,
            }
        };
        if xfade > 0.0 {
            let release = Release::new(*main, false, self.state.fade_out_samples, advance);
            push_release(&mut self.state.rels, release);
        }
        self.state.main = next;
        self.state.win_lo = next_lo;
        self.state.win_hi = next_hi;
        self.state.next_win = None;
    }

    /// Stop repeating: the current pass plays out with the full fade at the
    /// edge it is heading for.
    pub(super) fn end_loop(&mut self, advance: f64, max_frame: f64) {
        self.state.playing_out = true;
        self.state
            .main
            .play_out(advance >= 0.0, self.state.fade_frames, max_frame);
    }
}
