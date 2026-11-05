//! Session clock: an external clock source driven by a timeline that peers in
//! a multiplayer session agree on.
//!
//! Session time is the process host clock ([`session_clock_micros`]) plus a
//! per-peer offset estimated by the network layer. A [`SessionTimeline`] maps
//! session time to a bar position; peers that share a timeline and estimate
//! their offsets well land on the same bar at the same instant.
//!
//! The main thread validates a [`SessionClockConfig`] and ships it, with a
//! freshly built `HostTimeFilter`, through the command queue. Everything on
//! the audio thread is plain `Copy` math over pre-allocated state: the filter
//! holds a fixed-capacity point buffer, so feeding it never allocates.

use std::sync::OnceLock;
use std::time::Instant;

use napi_derive::napi;
use rusty_link::HostTimeFilter;

use crate::audio::TransportMeter;

static EPOCH: OnceLock<Instant> = OnceLock::new();

/// Monotonic microseconds since a process-wide epoch. The epoch is fixed by
/// the first call; the audio thread only reads it after the main thread has
/// called this while installing a session clock, so its reads are a plain
/// atomic load plus a monotonic clock read.
pub fn session_clock_micros() -> i64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_micros() as i64
}

/// A linear mapping from session time to bar position.
#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionTimeline {
    /// Session time (microseconds) at which the bar position is `anchor_bar`.
    pub anchor_micros: i64,
    /// Bar position at `anchor_micros`.
    pub anchor_bar: f64,
    /// Tempo in quarter notes per minute.
    pub bpm: f64,
    /// Quarter notes per bar.
    pub bar_beats: f64,
}

impl SessionTimeline {
    /// Bar position at session time `anchor_micros + dt_micros`.
    #[inline]
    pub fn bar_after(&self, dt_micros: f64) -> f64 {
        self.anchor_bar + dt_micros * self.bpm / 60e6 / self.bar_beats
    }

    /// Bar position at session time `t_micros`.
    #[cfg(test)]
    pub fn bar_at(&self, t_micros: i64) -> f64 {
        self.bar_after((t_micros - self.anchor_micros) as f64)
    }

    fn validate(&self, label: &str) -> napi::Result<()> {
        let valid = self.bpm.is_finite()
            && self.bpm > 0.0
            && self.bar_beats.is_finite()
            && self.bar_beats > 0.0
            && self.anchor_bar.is_finite();
        if valid {
            Ok(())
        } else {
            Err(napi::Error::from_reason(format!(
                "{label}: bpm and barBeats must be positive and anchorBar finite"
            )))
        }
    }
}

/// The session clock as configured by the network layer.
#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionClockConfig {
    /// Session time minus host time (`sessionClockMicros()`), in microseconds.
    pub offset_micros: i64,
    pub timeline: SessionTimeline,
    /// Replaces `timeline` once session time reaches its `anchor_micros`.
    pub pending: Option<SessionTimeline>,
}

impl SessionClockConfig {
    pub fn validate(&self) -> napi::Result<()> {
        self.timeline.validate("timeline")?;
        if let Some(p) = &self.pending {
            p.validate("pending")?;
        }
        Ok(())
    }

    /// Bar position and tempo at session time `session_micros + frac_micros`.
    #[inline]
    fn bar_at(&self, session_micros: i64, frac_micros: f64) -> (f64, f64) {
        let timeline = match &self.pending {
            Some(p) if session_micros >= p.anchor_micros => p,
            _ => &self.timeline,
        };
        let dt = (session_micros - timeline.anchor_micros) as f64 + frac_micros;
        (timeline.bar_after(dt), timeline.bpm)
    }
}

/// Bar phase in `[0, 1)` and bar number of a bar position.
#[inline]
pub fn split_bar(bar_position: f64) -> (f64, i64) {
    let bar = bar_position.floor();
    let phase = bar_position - bar;
    // `x - floor(x)` rounds up to exactly 1.0 for tiny negative `x`, which is
    // the start of the next bar.
    if phase >= 1.0 {
        (0.0, bar as i64 + 1)
    } else {
        (phase, bar as i64)
    }
}

/// One frame's reading of the session clock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionFrame {
    pub bar_phase: f64,
    pub bpm: f64,
    pub bar_position: f64,
    /// Completed bars since the transport origin, when one is set.
    pub bar_index: Option<u64>,
}

/// Per-buffer snapshot, captured once per callback.
#[derive(Debug, Clone, Copy)]
struct SessionBufferState {
    /// Filtered host time of the buffer's first frame, in microseconds.
    host_time_micros: i64,
    micros_per_sample: f64,
}

/// When a requested start should release.
#[derive(Debug, Clone, Copy, PartialEq)]
enum PendingStart {
    /// The start of the next bar after the request is first observed.
    NextBar,
    /// Once the bar position reaches this bar.
    AtBar(i64),
}

/// Audio-thread-side session clock state.
pub struct SessionClockState {
    config: Option<SessionClockConfig>,
    filter: Option<HostTimeFilter>,
    /// Running sample count for the host-time filter.
    sample_count: u64,
    buffer: Option<SessionBufferState>,
    /// Session bar the transport's bar count starts from. Until it is set
    /// the clock counts bar wraps locally, so the bar count is not shared.
    origin_bar: Option<i64>,
    pending_start: Option<PendingStart>,
}

impl SessionClockState {
    pub fn new() -> Self {
        Self {
            config: None,
            filter: None,
            sample_count: 0,
            buffer: None,
            origin_bar: None,
            pending_start: None,
        }
    }

    #[inline]
    pub fn is_active(&self) -> bool {
        self.config.is_some()
    }

    /// Install, update or remove the configuration. Returns a filter the
    /// caller must ship to the main thread for drop: the incoming one when
    /// the clock was already active (the running filter and sample count are
    /// kept so offset updates do not disturb timing), or the running one on
    /// deactivation.
    pub fn configure(
        &mut self,
        update: Option<(SessionClockConfig, HostTimeFilter)>,
    ) -> Option<HostTimeFilter> {
        match update {
            Some((config, filter)) => {
                self.config = Some(config);
                if self.filter.is_some() {
                    Some(filter)
                } else {
                    self.filter = Some(filter);
                    self.sample_count = 0;
                    self.buffer = None;
                    None
                }
            }
            None => {
                self.config = None;
                self.buffer = None;
                self.origin_bar = None;
                self.pending_start = None;
                self.filter.take()
            }
        }
    }

    /// Audio-callback prologue: capture the buffer's host time from the
    /// host clock reading `host_micros` ([`session_clock_micros`]) and promote
    /// a pending timeline whose anchor has passed. No-op when inactive.
    pub fn capture_at(&mut self, host_micros: i64, sample_rate: f32) {
        let (Some(config), Some(filter)) = (self.config.as_mut(), self.filter.as_mut()) else {
            self.buffer = None;
            return;
        };
        let host_time_micros = filter.sample_time_to_host_time(host_micros, self.sample_count);
        let session_micros = host_time_micros + config.offset_micros;
        if let Some(p) = config.pending
            && session_micros >= p.anchor_micros
        {
            config.timeline = p;
            config.pending = None;
        }
        self.buffer = Some(SessionBufferState {
            host_time_micros,
            micros_per_sample: 1_000_000.0 / sample_rate as f64,
        });
    }

    /// Advance the host-time filter's sample counter past this buffer.
    #[inline]
    pub fn add_samples(&mut self, n: u64) {
        self.sample_count = self.sample_count.saturating_add(n);
    }

    /// Session reading at cpal frame `cb_frame` of the current buffer, or
    /// `None` when inactive.
    #[inline]
    pub fn frame(&self, cb_frame: usize) -> Option<SessionFrame> {
        self.frame_at(cb_frame as f64)
    }

    fn frame_at(&self, cb_frame: f64) -> Option<SessionFrame> {
        let config = self.config.as_ref()?;
        let buffer = self.buffer.as_ref()?;
        let frac = cb_frame * buffer.micros_per_sample;
        let session_micros = buffer.host_time_micros + config.offset_micros + frac as i64;
        let (bar_position, bpm) = config.bar_at(session_micros, frac - frac.trunc());
        let (bar_phase, bar) = split_bar(bar_position);
        let bar_index = self.origin_bar.map(|origin| (bar - origin).max(0) as u64);
        Some(SessionFrame {
            bar_phase,
            bpm,
            bar_position,
            bar_index,
        })
    }

    /// Bar position at cpal frame `cb_frame`.
    #[inline]
    pub fn bar_position(&self, cb_frame: usize) -> Option<f64> {
        self.frame(cb_frame).map(|f| f.bar_position)
    }

    /// Whether the boundary into bar `target` lies strictly before cpal frame
    /// `cb_frame`, i.e. a frame earlier the bar position had already reached
    /// `target`.
    pub fn passed_bar_before(&self, target: i64, cb_frame: usize) -> bool {
        self.frame_at(cb_frame as f64 - 1.0)
            .is_some_and(|f| split_bar(f.bar_position).1 >= target)
    }

    /// Set the session bar the transport's bar count starts from.
    #[inline]
    pub fn set_origin_bar(&mut self, bar: i64) {
        self.origin_bar = Some(bar);
    }

    /// Arm a start that releases at the start of the next bar.
    pub fn request_start_next_bar(&mut self) {
        self.pending_start = Some(PendingStart::NextBar);
    }

    /// Arm a start that releases once the bar position reaches `bar`.
    pub fn request_start_at_bar(&mut self, bar: i64) {
        self.pending_start = Some(PendingStart::AtBar(bar));
    }

    #[inline]
    pub fn clear_pending_start(&mut self) {
        self.pending_start = None;
    }

    #[inline]
    pub fn pending_start_armed(&self) -> bool {
        self.pending_start.is_some()
    }

    /// Pin a next-bar start to the bar after the buffer's first frame. Called
    /// once per callback after the capture, so the target never moves.
    pub fn resolve_pending_start(&mut self) {
        if self.pending_start == Some(PendingStart::NextBar)
            && let Some(position) = self.bar_position(0)
        {
            let next = split_bar(position).1 + 1;
            self.pending_start = Some(PendingStart::AtBar(next));
        }
    }

    /// Offset within `[cb_frame, cb_frame + count)` of the first frame whose
    /// bar position has reached the armed start bar.
    pub fn pending_start_offset(&self, cb_frame: usize, count: usize) -> Option<usize> {
        let Some(PendingStart::AtBar(target)) = self.pending_start else {
            return None;
        };
        (0..count).find(|&offset| {
            self.bar_position(cb_frame + offset)
                .is_some_and(|position| position >= target as f64)
        })
    }

    /// Disarm the start once it plays and count the song's bars from its bar.
    pub fn release_pending_start(&mut self) {
        if let Some(PendingStart::AtBar(target)) = self.pending_start.take() {
            self.origin_bar = Some(target);
        }
    }

    /// Per-buffer transport-meter writes. The session timeline owns the tempo
    /// while active, so it overwrites the patch tempo in the meter.
    pub fn write_meter(&self, meter: &TransportMeter) {
        match self.frame(0) {
            Some(frame) => {
                meter.write_session_state(true, frame.bar_position, self.pending_start.is_some());
                meter.write_bpm(frame.bpm);
            }
            None => meter.write_session_state(self.is_active(), 0.0, false),
        }
    }

    /// Current timeline tempo, when active and captured.
    pub fn bpm(&self) -> Option<f64> {
        self.frame(0).map(|f| f.bpm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn timeline(anchor_micros: i64, anchor_bar: f64, bpm: f64, bar_beats: f64) -> SessionTimeline {
        SessionTimeline {
            anchor_micros,
            anchor_bar,
            bpm,
            bar_beats,
        }
    }

    fn active_state(config: SessionClockConfig) -> SessionClockState {
        let mut state = SessionClockState::new();
        assert!(
            state
                .configure(Some((config, HostTimeFilter::new())))
                .is_none()
        );
        state
    }

    #[test]
    fn timeline_maps_session_time_to_bars() {
        // 120 BPM in 4/4: one bar every two seconds.
        let t = timeline(10_000_000, 3.0, 120.0, 4.0);
        assert_eq!(t.bar_at(10_000_000), 3.0);
        assert_eq!(t.bar_at(12_000_000), 4.0);
        assert_eq!(t.bar_at(11_000_000), 3.5);
        assert_eq!(t.bar_at(8_000_000), 2.0);
        // 90 BPM in 3/4: a bar lasts two seconds too.
        let t = timeline(0, 0.0, 90.0, 3.0);
        assert_eq!(t.bar_at(2_000_000), 1.0);
    }

    #[test]
    fn split_bar_keeps_phase_below_one() {
        assert_eq!(split_bar(4.25), (0.25, 4));
        assert_eq!(split_bar(-0.25), (0.75, -1));
        assert_eq!(split_bar(-1e-18), (0.0, 0));
    }

    #[test]
    fn frames_advance_at_timeline_rate() {
        let mut state = active_state(SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(0, 0.0, 120.0, 4.0),
            pending: None,
        });
        state.capture_at(1_000_000, SR);
        let start = state.frame(0).unwrap();
        assert!((start.bar_position - 0.5).abs() < 1e-12);
        assert_eq!(start.bpm, 120.0);
        // 48 000 frames is one second, half a bar at 120 BPM in 4/4.
        let later = state.frame(48_000).unwrap();
        assert!((later.bar_position - 1.0).abs() < 1e-9);
        assert_eq!(start.bar_index, None);
    }

    #[test]
    fn pending_timeline_is_phase_continuous_at_its_anchor() {
        // 120 BPM 4/4 switches at bar 8 (t = 16 s) to 150 BPM 3/4.
        let old = timeline(0, 0.0, 120.0, 4.0);
        let switch_micros = 16_000_000;
        let new = timeline(switch_micros, old.bar_at(switch_micros), 150.0, 3.0);
        let mut state = active_state(SessionClockConfig {
            offset_micros: 0,
            timeline: old,
            pending: Some(new),
        });

        // A buffer straddling the switch reads the old mapping before the
        // anchor and the new one from it, without a jump in bar position.
        state.capture_at(switch_micros - 1_000, SR);
        let per_frame = 1_000_000.0 / SR as f64;
        let max_step = 150.0 / 60e6 / 3.0 * (per_frame + 1.0);
        let mut previous = state.frame(0).unwrap();
        assert_eq!(previous.bpm, 120.0);
        for f in 1..200 {
            let frame = state.frame(f).unwrap();
            let step = frame.bar_position - previous.bar_position;
            assert!(step > 0.0 && step < max_step, "frame {f} stepped {step}");
            previous = frame;
        }
        // 1 ms is 48 frames: the switch frame lands exactly on bar 8.
        let at_switch = state.frame(48).unwrap();
        assert_eq!(at_switch.bpm, 150.0);
        assert!((at_switch.bar_position - 8.0).abs() < 1e-9);
        assert!(at_switch.bar_phase < 1e-9);
        assert_eq!(state.frame(47).unwrap().bpm, 120.0);

        // The next capture promotes the pending timeline.
        state.add_samples(624);
        state.capture_at(switch_micros + 12_000, SR);
        assert_eq!(state.config.unwrap().pending, None);
        assert_eq!(state.config.unwrap().timeline, new);
        // 150 BPM in 3/4 is 1.2 s per bar.
        let bar = state.frame(0).unwrap().bar_position;
        assert!((bar - 8.01).abs() < 1e-3, "bar {bar}");
    }

    #[test]
    fn peers_with_different_offsets_agree_on_session_bars() {
        // Peer A's host clock reads 5 s at session time 105 s, peer B's reads
        // 73 s: same session mapping, different host offsets.
        let shared = timeline(100_000_000, 40.0, 128.0, 4.0);
        let mut a = active_state(SessionClockConfig {
            offset_micros: 100_000_000,
            timeline: shared,
            pending: None,
        });
        let mut b = active_state(SessionClockConfig {
            offset_micros: 32_000_000,
            timeline: shared,
            pending: None,
        });
        a.set_origin_bar(32);
        b.set_origin_bar(32);
        a.capture_at(5_000_000, SR);
        b.capture_at(73_000_000, SR);
        for f in [0, 1, 255, 4_800, 96_000] {
            assert_eq!(a.frame(f), b.frame(f));
        }
        let frame = a.frame(0).unwrap();
        // 5 s at 128 BPM 4/4 is 2.666… bars past bar 40.
        assert!((frame.bar_position - (40.0 + 5.0 * 128.0 / 60.0 / 4.0)).abs() < 1e-9);
        assert_eq!(frame.bar_index, Some(10));
    }

    #[test]
    fn bar_index_counts_from_origin_and_clamps_at_zero() {
        let mut state = active_state(SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(0, 0.0, 120.0, 4.0),
            pending: None,
        });
        state.capture_at(9_000_000, SR); // bar 4.5
        state.set_origin_bar(2);
        assert_eq!(state.frame(0).unwrap().bar_index, Some(2));
        state.set_origin_bar(6);
        assert_eq!(state.frame(0).unwrap().bar_index, Some(0));
    }

    #[test]
    fn reconfiguring_keeps_the_running_filter() {
        let config = SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(0, 0.0, 120.0, 4.0),
            pending: None,
        };
        let mut state = active_state(config);
        state.add_samples(1024);
        let unused = state.configure(Some((
            SessionClockConfig {
                offset_micros: 250,
                ..config
            },
            HostTimeFilter::new(),
        )));
        assert!(unused.is_some(), "the fresh filter goes back unused");
        assert_eq!(state.sample_count, 1024);
        assert_eq!(state.config.unwrap().offset_micros, 250);

        state.set_origin_bar(3);
        let removed = state.configure(None);
        assert!(removed.is_some(), "deactivation returns the running filter");
        assert!(!state.is_active());
        assert_eq!(state.origin_bar, None);
    }

    #[test]
    fn start_at_bar_finds_its_frame_and_sets_origin() {
        let mut state = active_state(SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(0, 0.0, 120.0, 4.0),
            pending: None,
        });
        state.request_start_at_bar(3);
        state.capture_at(5_990_000, SR); // bar 2.995
        state.resolve_pending_start();
        // 10 ms is 480 frames: bar 3 begins at frame 480.
        assert_eq!(state.pending_start_offset(0, 480), None);
        assert_eq!(state.pending_start_offset(0, 512), Some(480));
        assert_eq!(state.pending_start_offset(100, 512), Some(380));
        state.release_pending_start();
        assert!(!state.pending_start_armed());
        assert_eq!(state.origin_bar, Some(3));
        assert_eq!(state.frame(480).unwrap().bar_index, Some(0));
    }

    #[test]
    fn plain_start_resolves_to_the_next_bar() {
        let mut state = active_state(SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(0, 0.0, 120.0, 4.0),
            pending: None,
        });
        state.request_start_next_bar();
        assert_eq!(state.pending_start_offset(0, 1 << 20), None);
        state.capture_at(3_000_000, SR); // bar 1.5
        state.resolve_pending_start();
        assert_eq!(state.pending_start, Some(PendingStart::AtBar(2)));
        // A later capture does not move the target.
        state.add_samples(24_000);
        state.capture_at(3_500_000, SR); // bar 1.75
        state.resolve_pending_start();
        assert_eq!(state.pending_start_offset(0, 48_000), Some(24_000));
    }

    #[test]
    fn config_validation_rejects_degenerate_timelines() {
        let good = SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(0, 0.0, 120.0, 4.0),
            pending: None,
        };
        assert!(good.validate().is_ok());
        let zero_bpm = SessionClockConfig {
            timeline: timeline(0, 0.0, 0.0, 4.0),
            ..good
        };
        assert!(zero_bpm.validate().is_err());
        let bad_pending = SessionClockConfig {
            pending: Some(timeline(0, f64::NAN, 120.0, 4.0)),
            ..good
        };
        assert!(bad_pending.validate().is_err());
    }
}
