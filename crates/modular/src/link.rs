//! Ableton Link integration.
//!
//! Threading model (per official Link documentation in `Link.hpp`):
//!
//! * Construction, `enable()`, `enable_start_stop_sync()`, and drop of
//!   `AblLink` are documented "Realtime-safe: no" — they must run on the
//!   main thread. We package an enabled `AblLink` together with its
//!   `HostTimeFilter` and `SessionState` into [`LinkResources`] on the main
//!   thread and hand them to the audio thread via the command queue.
//!   Resources are returned via the existing garbage queue for main-thread
//!   drop.
//!
//! * Per-buffer and per-frame access on the audio thread uses only the
//!   realtime-safe API (`capture_audio_session_state`,
//!   `commit_audio_session_state`, `clock_micros`, `phase_at_time`).
//!
//! [`LinkState`] owns the audio-thread-side runtime state. The audio thread
//! never constructs or destroys an `AblLink` itself — it only swaps live
//! resources in and out via [`LinkState::install`].

use rusty_link::{AblLink, HostTimeFilter, SessionState};

use crate::audio::TransportMeter;

/// A bundle of Ableton Link runtime objects, constructed and torn down on
/// the main thread.
pub struct LinkResources {
    pub link: AblLink,
    pub host_time_filter: HostTimeFilter,
    pub session_state: SessionState,
}

/// Per-buffer Link session-state snapshot. Captured once per audio callback
/// to avoid repeated FFI calls per frame.
pub struct LinkBufferState {
    pub host_time_micros: i64,
    pub quantum: f64,
    pub tempo: f64,
    pub micros_per_sample: f64,
}

/// The bar-phase quantum used throughout the integration (4 beats = 1 bar).
const QUANTUM: f64 = 4.0;

/// Audio-thread-side Link state. Holds the live resources (when active),
/// the per-buffer snapshot, the running sample counter for the host-time
/// filter, an in-frame index, and the pending quantized-start flag.
pub struct LinkState {
    link: Option<AblLink>,
    host_time_filter: Option<HostTimeFilter>,
    session_state: Option<SessionState>,
    /// Running sample count for HostTimeFilter.
    sample_count: u64,
    /// Per-buffer Link snapshot, refreshed at the start of every audio
    /// callback by [`LinkState::capture_buffer_state`].
    buffer: Option<LinkBufferState>,
    /// Pending quantized start — a Start was requested but transport is
    /// waiting for the next Link bar boundary before actually playing.
    pending_start: bool,
    /// Shared bar numbering for a live session, or `None` outside one.
    session: Option<SessionTimeline>,
}

/// A live session's bar numbering over the Link timeline. Link aligns only
/// the phase within a bar between peers; the session supplies which bar it
/// is, so every peer agrees on bar numbers and on where the song began.
///
/// Session bar = `floor(link_beat / QUANTUM) + bar_offset`.
#[derive(Debug, Clone, Copy)]
struct SessionTimeline {
    bar_offset: i64,
    /// Session bar the playing song's bar 0 began on.
    song_origin: i64,
    /// Session bar an armed start releases on.
    start_bar: Option<i64>,
}

/// Link transport at one frame of the current buffer.
#[derive(Debug, Clone, Copy)]
pub struct LinkFrame {
    /// Bar phase in [0, 1).
    pub bar_phase: f64,
    pub tempo: f64,
    /// Session bar, inside a live session.
    pub session_bar: Option<i64>,
    /// Song bar (session bar counted from the song's origin), inside a live
    /// session.
    pub song_bar: Option<u64>,
}

impl LinkState {
    pub fn new() -> Self {
        Self {
            link: None,
            host_time_filter: None,
            session_state: None,
            sample_count: 0,
            buffer: None,
            pending_start: false,
            session: None,
        }
    }

    /// Whether Link is currently active (resources installed).
    #[inline]
    pub fn is_active(&self) -> bool {
        self.link.is_some()
    }

    /// Install or remove Link resources. Returns the previously-held resources
    /// (if any) so the caller can ship them to the garbage queue for
    /// main-thread drop. Also clears any pending start and the per-buffer
    /// snapshot whenever the live instance changes.
    pub fn install(&mut self, new: Option<Box<LinkResources>>) -> Option<Box<LinkResources>> {
        let old = self.take();

        if let Some(res) = new {
            let LinkResources {
                link,
                host_time_filter,
                session_state,
            } = *res;
            self.link = Some(link);
            self.host_time_filter = Some(host_time_filter);
            self.session_state = Some(session_state);
            self.sample_count = 0;
        }

        old
    }

    /// Take the current resources (if any), leaving Link inactive. Used both
    /// for swap (via `install`) and explicit teardown.
    fn take(&mut self) -> Option<Box<LinkResources>> {
        self.buffer = None;
        self.pending_start = false;
        if let Some(session) = self.session.as_mut() {
            session.start_bar = None;
        }

        match (
            self.link.take(),
            self.host_time_filter.take(),
            self.session_state.take(),
        ) {
            (Some(link), Some(host_time_filter), Some(session_state)) => {
                Some(Box::new(LinkResources {
                    link,
                    host_time_filter,
                    session_state,
                }))
            }
            _ => None,
        }
    }

    /// Force-clear the pending-start flag. Called on explicit Stop so a later
    /// peer-start cannot resurrect a cancelled patch.
    #[inline]
    pub fn clear_pending_start(&mut self) {
        self.pending_start = false;
        if let Some(session) = self.session.as_mut() {
            session.start_bar = None;
        }
    }

    /// Enter a live session with this bar offset, update the offset of the
    /// current one, or leave it (`None`). Updating keeps the song origin and
    /// any armed start, which are in session bars.
    pub fn set_session_offset(&mut self, bar_offset: Option<i64>) {
        self.session = bar_offset.map(|bar_offset| match self.session {
            Some(session) => SessionTimeline {
                bar_offset,
                ..session
            },
            None => SessionTimeline {
                bar_offset,
                song_origin: 0,
                start_bar: None,
            },
        });
    }

    /// Whether a live session owns the bar numbering.
    #[inline]
    pub fn in_session(&self) -> bool {
        self.session.is_some()
    }

    /// Arm a session start: playback begins once the session reaches `bar`,
    /// and that bar becomes the song's bar 0. A bar already passed releases
    /// on the next buffer, joining the song mid-way.
    pub fn arm_session_start(&mut self, bar: i64) {
        if let Some(session) = self.session.as_mut() {
            session.start_bar = Some(bar);
            session.song_origin = bar;
        }
    }

    /// Make the session bar at `cb_frame` the song's bar 0.
    pub fn restart_song_at_frame(&mut self, cb_frame: usize) {
        if let Some(bar) = self.frame(cb_frame).and_then(|f| f.session_bar)
            && let Some(session) = self.session.as_mut()
        {
            session.song_origin = bar;
        }
    }

    /// Audio-callback prologue: capture the session state once per buffer.
    /// No-op when Link is inactive.
    pub fn capture_buffer_state(&mut self, sample_rate: f32) {
        self.buffer = self.capture(sample_rate);
    }

    fn capture(&mut self, sample_rate: f32) -> Option<LinkBufferState> {
        let link = self.link.as_ref()?;
        let htf = self.host_time_filter.as_mut()?;
        let ss = self.session_state.as_mut()?;

        let clock_micros = link.clock_micros();
        let host_time_micros = htf.sample_time_to_host_time(clock_micros, self.sample_count);
        link.capture_audio_session_state(ss);
        let tempo = ss.tempo();
        let micros_per_sample = 1_000_000.0 / sample_rate as f64;

        Some(LinkBufferState {
            host_time_micros,
            quantum: QUANTUM,
            tempo,
            micros_per_sample,
        })
    }

    /// Check whether a pending quantized start should be released this buffer.
    /// Returns `true` exactly once — when the bar boundary the start was
    /// quantized to has been reached — and clears the flag. The caller is
    /// responsible for flipping the stopped atomic and dispatching
    /// `Clock::Start`.
    pub fn check_pending_start_release(&mut self) -> bool {
        if let Some(start_bar) = self.session.and_then(|s| s.start_bar) {
            let reached = self
                .frame(0)
                .and_then(|f| f.session_bar)
                .is_some_and(|bar| bar >= start_bar);
            if reached && let Some(session) = self.session.as_mut() {
                session.start_bar = None;
            }
            return reached;
        }
        if !self.pending_start {
            return false;
        }
        let buffer = match &self.buffer {
            Some(b) => b,
            None => return false,
        };
        let ss = match &self.session_state {
            Some(s) => s,
            None => return false,
        };
        // `request_quantized_start` maps beat 0 to the boundary: with peers
        // the session timeline is fixed and Link reports negative beats until
        // the boundary arrives; solo, beat 0 maps to the request time itself.
        // Either way the start releases exactly when the beat turns
        // non-negative.
        let beat = ss.beat_at_time(buffer.host_time_micros, buffer.quantum);
        if beat >= 0.0 {
            self.pending_start = false;
            true
        } else {
            false
        }
    }

    /// Link transport at the given cpal-frame offset within the current
    /// callback's buffer snapshot. Returns `None` when Link is inactive.
    /// Pure read — used by the eager-fill loop to sync ROOT_CLOCK one
    /// sample at a time across arbitrary frame indices in a callback.
    pub fn frame(&self, cb_frame: usize) -> Option<LinkFrame> {
        let buffer = self.buffer.as_ref()?;
        let ss = self.session_state.as_ref()?;
        let frame_offset_micros = (cb_frame as f64 * buffer.micros_per_sample) as i64;
        let frame_host_time = buffer.host_time_micros + frame_offset_micros;
        let Some(session) = self.session else {
            let phase = ss.phase_at_time(frame_host_time, buffer.quantum);
            return Some(LinkFrame {
                bar_phase: phase / buffer.quantum,
                tempo: buffer.tempo,
                session_bar: None,
                song_bar: None,
            });
        };
        // Phase and bar both come from the one beat reading so a bar
        // boundary moves them together.
        let bars = ss.beat_at_time(frame_host_time, buffer.quantum) / buffer.quantum;
        let link_bar = bars.floor();
        let session_bar = link_bar as i64 + session.bar_offset;
        Some(LinkFrame {
            bar_phase: bars - link_bar,
            tempo: buffer.tempo,
            session_bar: Some(session_bar),
            song_bar: Some(session_bar.saturating_sub(session.song_origin).max(0) as u64),
        })
    }

    /// Link bars (beats / quantum) at the start of the current buffer.
    pub fn buffer_bars(&self) -> Option<f64> {
        let buffer = self.buffer.as_ref()?;
        let ss = self.session_state.as_ref()?;
        Some(ss.beat_at_time(buffer.host_time_micros, buffer.quantum) / buffer.quantum)
    }

    /// Push an explicit tempo override to the Link session via the RT-safe
    /// capture/commit pair.
    pub fn set_tempo_now(&mut self, tempo: f64) {
        if let (Some(link), Some(ss)) = (&self.link, &mut self.session_state) {
            link.capture_audio_session_state(ss);
            let time = link.clock_micros();
            ss.set_tempo(tempo, time);
            link.commit_audio_session_state(ss);
        }
    }

    /// Arm a quantized start — request `is_playing=true` + beat=0 at the next
    /// bar boundary. Sets the pending_start flag so the audio loop can
    /// release the local stopped atomic when the boundary arrives.
    pub fn request_quantized_start(&mut self) {
        if let (Some(link), Some(ss)) = (&self.link, &mut self.session_state) {
            link.capture_audio_session_state(ss);
            let time = link.clock_micros();
            ss.set_is_playing_and_request_beat_at_time(true, time, 0.0, QUANTUM);
            link.commit_audio_session_state(ss);
            self.pending_start = true;
        }
    }

    /// Propagate a stop to the Link session.
    pub fn signal_stop(&mut self) {
        if let (Some(link), Some(ss)) = (&self.link, &mut self.session_state) {
            link.capture_audio_session_state(ss);
            let time = link.clock_micros();
            ss.set_is_playing(false, time);
            link.commit_audio_session_state(ss);
        }
    }

    /// Advance the host-time filter sample counter by the number of frames
    /// processed in this buffer.
    #[inline]
    pub fn add_samples(&mut self, n: u64) {
        self.sample_count = self.sample_count.saturating_add(n);
    }

    /// Per-buffer transport-meter writes for UI display: enabled flag,
    /// peer count, current Link tempo, free-running bar phase, and the
    /// pending-start flag. When Link is inactive only `link_pending_start`
    /// is reset (the enabled/peers state is already maintained by the
    /// main thread on disable).
    pub fn write_meter(&self, meter: &TransportMeter) {
        if let Some(ref link) = self.link {
            meter.write_link_state(true, link.num_peers() as u32);
            if let Some(ref buffer) = self.buffer {
                meter.write_bpm(buffer.tempo);
                if let Some(ref ss) = self.session_state {
                    let phase = ss.phase_at_time(buffer.host_time_micros, buffer.quantum);
                    let bar_phase = phase / buffer.quantum;
                    meter.write_link_phase(bar_phase);
                }
            }
            meter.write_link_pending_start(
                self.pending_start || self.session.is_some_and(|s| s.start_bar.is_some()),
            );
            if let Some(bars) = self.buffer_bars() {
                meter.write_link_bars(bars);
            }
        } else {
            meter.write_link_pending_start(false);
        }
    }
}

#[cfg(test)]
impl LinkState {
    /// A `LinkState` inside a session with `bar_offset`, holding `ss` and a
    /// buffer captured at `host_time_micros`.
    pub(crate) fn session_for_test(
        link: AblLink,
        ss: SessionState,
        host_time_micros: i64,
        sample_rate: f32,
        bar_offset: i64,
    ) -> Self {
        let mut state = LinkState::new();
        state.link = Some(link);
        state.session_state = Some(ss);
        state.buffer = Some(LinkBufferState {
            host_time_micros,
            quantum: QUANTUM,
            tempo: 120.0,
            micros_per_sample: 1_000_000.0 / sample_rate as f64,
        });
        state.set_session_offset(Some(bar_offset));
        state
    }

    pub(crate) fn set_buffer_host_time_for_test(&mut self, host_time_micros: i64) {
        self.buffer.as_mut().unwrap().host_time_micros = host_time_micros;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One bar at 120 BPM in 4/4.
    const BAR_MICROS: i64 = 2_000_000;

    /// A session-mode `LinkState` whose Link beat 0 sits at the returned
    /// host time, captured at that time.
    fn session_at_beat_zero(bar_offset: i64) -> (LinkState, i64) {
        let link = AblLink::new(120.0);
        let mut ss = SessionState::new();
        link.capture_app_session_state(&mut ss);
        let t0 = link.clock_micros();
        ss.force_beat_at_time(0.0, t0, QUANTUM);
        (
            LinkState::session_for_test(link, ss, t0, 48_000.0, bar_offset),
            t0,
        )
    }

    #[test]
    fn session_bars_are_link_bars_plus_offset() {
        let (mut state, t0) = session_at_beat_zero(10);
        state.set_buffer_host_time_for_test(t0 + 2 * BAR_MICROS + BAR_MICROS / 2);
        let frame = state.frame(0).unwrap();
        assert_eq!(frame.session_bar, Some(12));
        assert!((frame.bar_phase - 0.5).abs() < 1e-6);
        assert!((state.buffer_bars().unwrap() - 2.5).abs() < 1e-6);
    }

    #[test]
    fn session_start_releases_on_its_bar_and_counts_the_song_from_it() {
        let (mut state, t0) = session_at_beat_zero(10);
        state.arm_session_start(11);

        state.set_buffer_host_time_for_test(t0 + BAR_MICROS - 1_000);
        assert!(!state.check_pending_start_release());

        state.set_buffer_host_time_for_test(t0 + BAR_MICROS + 1_000);
        assert!(state.check_pending_start_release());
        assert!(!state.check_pending_start_release());
        assert_eq!(state.frame(0).unwrap().song_bar, Some(0));

        state.set_buffer_host_time_for_test(t0 + 3 * BAR_MICROS + BAR_MICROS / 5);
        assert_eq!(state.frame(0).unwrap().song_bar, Some(2));
    }

    #[test]
    fn session_start_on_a_passed_bar_joins_the_song_mid_way() {
        let (mut state, t0) = session_at_beat_zero(0);
        state.set_buffer_host_time_for_test(t0 + 7 * BAR_MICROS + BAR_MICROS / 3);
        state.arm_session_start(3);
        assert!(state.check_pending_start_release());
        assert_eq!(state.frame(0).unwrap().song_bar, Some(4));
    }

    #[test]
    fn new_session_offset_keeps_song_origin_and_armed_start() {
        let (mut state, t0) = session_at_beat_zero(0);
        state.arm_session_start(5);
        // The same session bars now sit one Link bar later on this peer.
        state.set_session_offset(Some(-1));
        state.set_buffer_host_time_for_test(t0 + 5 * BAR_MICROS + 1_000);
        assert!(!state.check_pending_start_release());
        state.set_buffer_host_time_for_test(t0 + 6 * BAR_MICROS + 1_000);
        assert!(state.check_pending_start_release());
        assert_eq!(state.frame(0).unwrap().song_bar, Some(0));
    }

    #[test]
    fn stop_disarms_a_session_start() {
        let (mut state, t0) = session_at_beat_zero(0);
        state.arm_session_start(1);
        state.clear_pending_start();
        state.set_buffer_host_time_for_test(t0 + 2 * BAR_MICROS);
        assert!(!state.check_pending_start_release());
    }

    /// A `LinkState` with a pending start, holding the given session snapshot
    /// and a buffer captured at `host_time_micros`.
    fn armed_state(link: AblLink, ss: SessionState, host_time_micros: i64) -> LinkState {
        let mut state = LinkState::new();
        state.link = Some(link);
        state.session_state = Some(ss);
        state.buffer = Some(LinkBufferState {
            host_time_micros,
            quantum: QUANTUM,
            tempo: 120.0,
            micros_per_sample: 1_000_000.0 / 48_000.0,
        });
        state.pending_start = true;
        state
    }

    #[test]
    fn buffer_bars_counts_link_beats_in_bars() {
        let link = AblLink::new(120.0);
        let mut ss = SessionState::new();
        link.capture_app_session_state(&mut ss);
        let t0 = link.clock_micros();
        ss.force_beat_at_time(0.0, t0, QUANTUM);
        // Ten beats at 120 BPM.
        let state = armed_state(link, ss, t0 + 5_000_000);
        assert!((state.buffer_bars().unwrap() - 2.5).abs() < 1e-6);
    }

    #[test]
    fn pending_start_holds_until_bar_boundary() {
        let link = AblLink::new(120.0);
        let mut ss = SessionState::new();
        link.capture_app_session_state(&mut ss);
        let now = link.clock_micros();
        // Pin beat 0 a bar ahead, as a peer-locked session does when a start
        // is armed mid-bar (the shared timeline cannot be re-mapped).
        let boundary = now + 2_000_000; // 4 beats at 120 BPM
        ss.force_beat_at_time(0.0, boundary, QUANTUM);

        // Armed at bar phase ~0.3 beats: must not release before the boundary.
        let mut state = armed_state(link, ss, boundary - 1_850_000);
        assert!(!state.check_pending_start_release());
        assert!(state.pending_start);

        state.buffer.as_mut().unwrap().host_time_micros = boundary - 10_000;
        assert!(!state.check_pending_start_release());

        // Boundary reached: releases exactly once.
        state.buffer.as_mut().unwrap().host_time_micros = boundary + 1_000;
        assert!(state.check_pending_start_release());
        assert!(!state.check_pending_start_release());
    }

    #[test]
    fn pending_start_releases_immediately_after_solo_remap() {
        let link = AblLink::new(120.0);
        let mut ss = SessionState::new();
        link.capture_app_session_state(&mut ss);
        let now = link.clock_micros();
        // With no peers, the quantized-start request maps beat 0 to the
        // request time itself, so the release fires on the next check.
        ss.request_beat_at_time(0.0, now, QUANTUM);

        let mut state = armed_state(link, ss, now);
        assert!(state.check_pending_start_release());
        assert!(!state.pending_start);
    }
}
