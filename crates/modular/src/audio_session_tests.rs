//! Audio-thread tests for the session clock, driven through the real
//! callback loop (`AudioProcessor::render_callback`): `at_bar` updates, the
//! shared bar count, frame-exact starts, peer determinism, and allocation
//! freedom of those paths.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use modular_core::types::{ExternalClockState, ROOT_CLOCK_ID, ROOT_ID};

use super::tests::{
    ConstantOutputModule, build_root_clock_at, create_processor, create_test_processor,
    insert_running_root_clock,
};
use super::*;
use crate::recording::RecordingFeed;
use crate::session_clock::{SessionClockConfig, SessionTimeline};

/// Counts heap traffic on threads that opt in, so parallel tests do not
/// disturb each other's counts.
struct CountingAllocator;

thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
    static EVENTS: Cell<usize> = const { Cell::new(0) };
}

fn record_event() {
    if COUNTING.try_with(Cell::get).unwrap_or(false) {
        let _ = EVENTS.try_with(|e| e.set(e.get() + 1));
    }
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_event();
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        record_event();
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_event();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[cfg(not(feature = "alloc-detector"))]
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

/// Heap allocations and deallocations made by `f` on this thread.
fn heap_events(f: impl FnOnce()) -> usize {
    EVENTS.with(|e| e.set(0));
    COUNTING.with(|c| c.set(true));
    f();
    COUNTING.with(|c| c.set(false));
    EVENTS.with(Cell::get)
}

/// Raw root output of the patch a peer starts with.
const BEFORE: f32 = 0.25;
/// Raw root output of the patch an update swaps in.
const AFTER: f32 = 0.5;

/// A 120 BPM 4/4 timeline at bar `bar` at session time `anchor_micros`.
fn timeline(anchor_micros: i64, bar: f64) -> SessionTimeline {
    SessionTimeline {
        anchor_micros,
        anchor_bar: bar,
        bpm: 120.0,
        bar_beats: 4.0,
    }
}

fn config(offset_micros: i64, timeline: SessionTimeline) -> SessionClockConfig {
    SessionClockConfig {
        offset_micros,
        timeline,
        pending: None,
    }
}

/// A patch update whose root outputs `value`, with a ROOT_CLOCK.
fn patch_update(sample_rate: f32, block_size: usize, value: f32) -> PatchUpdate {
    let mut update = PatchUpdate::new(sample_rate);
    update.new_patch.sampleables.insert(
        ROOT_ID.to_string(),
        ConstantOutputModule::new(&ROOT_ID, value),
    );
    update.new_patch.sampleables.insert(
        ROOT_CLOCK_ID.to_string(),
        build_root_clock_at(sample_rate, block_size),
    );
    update.new_patch.rebuild_message_listeners();
    update
}

/// One engine instance driven callback by callback, with a host clock that
/// advances exactly with the frames rendered.
struct Peer {
    cmd: CommandProducer,
    p: AudioProcessor,
    final_state: FinalStateProcessor,
    input: InputBufferReader,
    recording: Mutex<Option<RecordingFeed>>,
    sample_rate: f32,
    host0: i64,
    offset_micros: i64,
    /// Channel 0 of every frame rendered so far.
    out: Vec<f32>,
}

impl Peer {
    /// A stopped peer playing the `BEFORE` patch, its session clock on
    /// `timeline` with session time = host time + `offset_micros`.
    fn new(
        sample_rate: f32,
        block_size: usize,
        host0: i64,
        offset_micros: i64,
        timeline: SessionTimeline,
    ) -> Self {
        let (cmd, mut p) = create_processor(sample_rate, block_size);
        p.apply_patch_update(patch_update(sample_rate, block_size, BEFORE), 0);
        let (_writer, input) = create_input_ring_buffer(1);
        let mut peer = Self {
            cmd,
            p,
            final_state: FinalStateProcessor::new(sample_rate),
            input,
            recording: Mutex::new(None),
            sample_rate,
            host0,
            offset_micros,
            out: Vec::with_capacity(1 << 20),
        };
        peer.send(GraphCommand::SetSessionClock(Some((
            config(offset_micros, timeline),
            rusty_link::HostTimeFilter::new(),
        ))));
        peer
    }

    fn send(&mut self, cmd: GraphCommand) {
        assert!(self.cmd.push(cmd).is_ok());
    }

    fn queue(&mut self, update: PatchUpdate) {
        self.send(GraphCommand::QueuedPatchUpdate {
            update,
            trigger: QueuedTrigger::NextBar,
        });
    }

    fn at_bar_update(&self, update_id: u64, at_bar: i64) -> PatchUpdate {
        let mut update = patch_update(self.sample_rate, self.p.block_size, AFTER);
        update.update_id = update_id;
        update.at_bar = Some(at_bar);
        update
    }

    fn play(&mut self) {
        self.p.stopped.store(false, Ordering::SeqCst);
    }

    /// Session time of frame `frame`, in microseconds.
    fn session_micros(&self, frame: usize) -> f64 {
        (self.host0 + self.offset_micros) as f64 + frame as f64 * 1e6 / self.sample_rate as f64
    }

    /// Render one callback of `frames` frames.
    fn render(&mut self, frames: usize) {
        let base = self.out.len();
        let host = self.host0 + (base as f64 * 1e6 / self.sample_rate as f64).round() as i64;
        self.out.resize(base + frames, 0.0);
        let out = &mut self.out[base..];
        self.p.render_callback(
            frames,
            1,
            host,
            &mut self.final_state,
            &mut self.input,
            &self.recording,
            |frame, ch, v| {
                if ch == 0 {
                    out[frame] = v;
                }
            },
        );
    }

    /// Render `total` frames in callbacks of `chunk` frames.
    fn render_chunks(&mut self, total: usize, chunk: usize) {
        let end = self.out.len() + total;
        while self.out.len() < end {
            self.render(chunk.min(end - self.out.len()));
        }
    }

    /// First frame that sounds at all.
    fn first_sound(&self) -> usize {
        self.out
            .iter()
            .position(|&v| v != 0.0)
            .expect("audio starts")
    }

    /// Frame at which the `AFTER` patch swapped in. The swap's declick holds
    /// the swap frame at the previous output, so the output first changes on
    /// the frame after it.
    fn swap_frame(&self) -> usize {
        let before = self.out[self.first_sound()];
        let from = self.first_sound();
        from + self.out[from..]
            .iter()
            .position(|&v| v != before)
            .expect("update applies")
            - 1
    }

    fn snapshot(&self) -> TransportSnapshot {
        self.p.transport_meter.snapshot()
    }
}

/// Frame at which a peer starting at session time `start` reaches session
/// time `t`, rounded up.
fn frame_at(start: f64, t: f64, sample_rate: f32) -> f64 {
    ((t - start) * sample_rate as f64 / 1e6).ceil()
}

fn assert_near(actual: usize, expected: f64) {
    assert!(
        (actual as f64 - expected).abs() <= 1.0,
        "frame {actual}, expected {expected}"
    );
}

const HOST: i64 = 1_000_000;

#[test]
fn start_at_bar_sounds_from_its_exact_frame() {
    // Bar 4 begins 0.2 s in: frame 8 820, mid-callback and mid-block.
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.9));
    peer.send(GraphCommand::StartAtBar(4));
    peer.render_chunks(12_000, 1_000);

    let start = peer.first_sound();
    assert_near(start, 8_820.0);
    assert_ne!(start % 64, 0, "the start lands mid-block");
    assert!(peer.out[..start].iter().all(|&v| v == 0.0));
    assert!(peer.out[start..].iter().all(|&v| v != 0.0));
    let snap = peer.snapshot();
    assert!(snap.is_playing);
    assert!(!snap.session_pending_start);
    assert_eq!(snap.bar, 0);
}

#[test]
fn stopped_peer_starts_and_swaps_on_the_shared_bar() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.75));
    peer.send(GraphCommand::StartAtBar(4));
    let update = peer.at_bar_update(1, 4);
    peer.queue(update);
    peer.render_chunks(30_000, 512);

    // Bar 4 is 0.5 s in. The swap's declick ramps the first frame up from
    // the silence before it.
    let start = peer.first_sound() - 1;
    assert_near(start, 22_050.0);
    assert!(peer.out[..=start].iter().all(|&v| v == 0.0));
    assert_eq!(peer.snapshot().last_applied_update_id, 1.0);
}

#[test]
fn at_bar_update_applies_on_its_bar() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.75));
    peer.play();
    let update = peer.at_bar_update(1, 4);
    peer.queue(update);
    peer.render_chunks(30_000, 500);

    let swap = peer.swap_frame();
    assert_near(swap, 22_050.0);
    assert_ne!(swap % 64, 0, "the swap lands mid-block");
    let snap = peer.snapshot();
    assert_eq!(snap.last_applied_update_id, 1.0);
    assert_eq!(snap.last_late_update_id, 0.0);
}

#[test]
fn late_at_bar_update_applies_at_the_next_bar_and_is_reported() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 4.25));
    peer.play();
    let update = peer.at_bar_update(7, 4);
    peer.queue(update);
    peer.render_chunks(70_000, 500);

    // Bar 5 is 0.75 bars (1.5 s) in.
    assert_near(peer.swap_frame(), 66_150.0);
    let snap = peer.snapshot();
    assert_eq!(snap.last_applied_update_id, 7.0);
    assert_eq!(snap.last_late_update_id, 7.0);
}

#[test]
fn late_reset_clock_update_counts_from_its_requested_bar() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 4.25));
    peer.play();
    let mut update = peer.at_bar_update(3, 4);
    update.reset_clock = true;
    peer.queue(update);
    // Through the late swap at bar 5 and into it.
    peer.render_chunks(66_150 + 2_000, 500);

    assert_near(peer.swap_frame(), 66_150.0);
    let snap = peer.snapshot();
    assert_eq!(snap.last_late_update_id, 3.0);
    assert_eq!(
        snap.bar, 1,
        "a peer that applied on time is at bar index 1 too"
    );
}

#[test]
fn explicit_origin_gives_on_time_and_late_peers_one_bar_count() {
    // One timeline, bar 3.75 at `HOST`. A joins then and applies its bar-4
    // update on time; B joins half a bar later and applies late, at bar 5,
    // with a reset. Both carry the song's origin, bar 2.
    let shared = timeline(HOST, 3.75);
    let mut a = Peer::new(44_100.0, 64, HOST, 0, shared);
    let mut b = Peer::new(48_000.0, 128, HOST + 1_000_000, 0, shared);
    let mut on_time = a.at_bar_update(1, 4);
    on_time.origin_bar = Some(2);
    let mut late = b.at_bar_update(1, 4);
    late.origin_bar = Some(2);
    late.reset_clock = true;
    a.play();
    b.play();
    a.queue(on_time);
    b.queue(late);

    // Both render through bar 5.1, session time `HOST` + 2.7 s.
    a.render_chunks(119_070, 500);
    b.render_chunks(81_600, 333);

    assert_eq!(a.snapshot().last_late_update_id, 0.0);
    assert_eq!(b.snapshot().last_late_update_id, 1.0);
    assert_eq!(a.snapshot().bar, 3);
    assert_eq!(b.snapshot().bar, 3);
}

#[test]
fn newer_at_bar_update_replaces_the_queued_one_and_keeps_its_bar() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.75));
    peer.play();
    let first = peer.at_bar_update(1, 6);
    peer.queue(first);
    let second = peer.at_bar_update(2, 4);
    peer.queue(second);
    peer.render(1);

    let (queued, trigger) = peer.p.queued_update.as_ref().unwrap();
    assert_eq!(queued.update_id, 2);
    assert!(matches!(trigger, QueuedTrigger::NextBar));

    peer.render_chunks(30_000, 500);
    assert_near(peer.swap_frame(), 22_050.0);
    assert_eq!(peer.snapshot().last_applied_update_id, 2.0);
}

#[test]
fn at_bar_update_follows_a_pending_timeline_switch() {
    // 120 BPM until bar 3.5 (1 s in), then 150 BPM: bar 4 arrives half a
    // 1.6 s bar later, 1.8 s in.
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.0));
    peer.send(GraphCommand::SetSessionClock(Some((
        SessionClockConfig {
            offset_micros: 0,
            timeline: timeline(HOST, 3.0),
            pending: Some(SessionTimeline {
                anchor_micros: HOST + 1_000_000,
                anchor_bar: 3.5,
                bpm: 150.0,
                bar_beats: 4.0,
            }),
        },
        rusty_link::HostTimeFilter::new(),
    ))));
    peer.play();
    let update = peer.at_bar_update(1, 4);
    peer.queue(update);
    peer.render_chunks(90_000, 441);

    assert_near(peer.swap_frame(), 79_380.0);
    assert_eq!(peer.snapshot().bpm, 150.0);
}

#[test]
fn peers_with_different_rates_chunks_and_offsets_agree() {
    // Session time 4 s is bar 1.5 for both peers. A joins at session time
    // 4 s, B at 4.5 s; both start at bar 2 and switch patches at bar 3.
    let shared = timeline(4_000_000, 1.5);
    let mut a = Peer::new(44_100.0, 64, 1_000_000, 3_000_000, shared);
    let mut b = Peer::new(48_000.0, 128, 9_000_000, -4_500_000, shared);
    for peer in [&mut a, &mut b] {
        peer.send(GraphCommand::StartAtBar(2));
        let update = peer.at_bar_update(1, 3);
        peer.queue(update);
    }
    // Bars last 2 s: bar 2 is at session time 5 s, bar 3 at 7 s. Render
    // through bar 3.5.
    a.render_chunks(frame_at(4e6, 8e6, 44_100.0) as usize, 500);
    b.render_chunks(frame_at(4.5e6, 8e6, 48_000.0) as usize, 333);

    // Host times are whole microseconds, so a boundary can land a sample
    // either side of its exact frame.
    let one_sample = 1e6 / 44_100.0 + 1.0;
    let start_a = a.session_micros(a.first_sound());
    let start_b = b.session_micros(b.first_sound());
    assert!((start_a - 5e6).abs() <= one_sample, "A starts at {start_a}");
    assert!((start_b - 5e6).abs() <= one_sample, "B starts at {start_b}");
    let swap_a = a.session_micros(a.swap_frame());
    let swap_b = b.session_micros(b.swap_frame());
    assert!((swap_a - 7e6).abs() <= one_sample, "A swaps at {swap_a}");
    assert!((swap_b - swap_a).abs() <= one_sample, "B swaps at {swap_b}");
    assert_eq!(a.snapshot().bar, 1);
    assert_eq!(b.snapshot().bar, 1);
}

#[test]
fn session_clock_owns_the_meter_tempo() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 0.0));
    peer.render(64);
    let mut update = PatchUpdate::new(44_100.0);
    update.transport_meta = Some(TransportMeta {
        tempo: 90.0,
        numerator: 3,
        denominator: 4,
        tempo_set: true,
    });
    peer.p.apply_patch_update(update, 0);
    let snap = peer.snapshot();
    assert_eq!(snap.bpm, 120.0);
    assert_eq!(snap.time_sig_numerator, 3);
}

#[test]
fn deactivating_clears_root_clock_external_sync() {
    let (mut cmd, mut p) = create_test_processor();
    let id = insert_running_root_clock(&mut p);
    assert!(
        cmd.push(GraphCommand::SetSessionClock(Some((
            config(0, timeline(0, 0.0)),
            rusty_link::HostTimeFilter::new(),
        ))))
        .is_ok()
    );
    p.process_commands();

    // A sync injected but not yet consumed when the clock goes away.
    let clock = p.patch.sampleables.get(&id).unwrap();
    clock.sync_external_clock(ExternalClockState {
        bar_phase: 0.9,
        bpm: 120.0,
        bar_index: None,
    });
    assert!(cmd.push(GraphCommand::SetSessionClock(None)).is_ok());
    p.process_commands();

    // The clock free-runs from phase 0: one 120 BPM 4/4 sample at 44.1 kHz.
    let clock = p.patch.sampleables.get(&id).unwrap();
    clock.start_block();
    let phase = clock.get_value_at("playhead", 0, 0);
    assert!((phase - 1.0 / 88_200.0).abs() < 1e-6, "phase {phase}");
}

#[test]
fn deactivating_with_a_start_armed_starts_free_running() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.0));
    peer.send(GraphCommand::StartAtBar(10));
    peer.render(64);
    assert!(peer.p.is_stopped());
    assert!(peer.snapshot().session_pending_start);

    peer.send(GraphCommand::SetSessionClock(None));
    peer.render(64);
    assert!(!peer.p.is_stopped());
    assert!(!peer.snapshot().session_clock_active);
    assert!(peer.out[64..].iter().all(|&v| v != 0.0));
}

#[cfg(not(feature = "alloc-detector"))]
#[test]
fn session_clock_paths_do_not_touch_the_heap() {
    let mut peer = Peer::new(44_100.0, 64, HOST, 0, timeline(HOST, 3.75));
    // Warm the clock and the filter's point buffer.
    peer.render_chunks(1_024, 256);

    peer.send(GraphCommand::StartAtBar(4));
    let mut update = peer.at_bar_update(1, 4);
    update.reset_clock = true;
    peer.queue(update);
    let mut refined = config(120, timeline(HOST, 3.75));
    refined.pending = Some(SessionTimeline {
        anchor_micros: HOST + 1_000_000,
        anchor_bar: 4.25,
        bpm: 140.0,
        bar_beats: 4.0,
    });
    peer.send(GraphCommand::SetSessionClock(Some((
        refined,
        rusty_link::HostTimeFilter::new(),
    ))));
    let late = peer.at_bar_update(2, 4);

    let events = heap_events(|| {
        // Start, swap and timeline switch, at a 300-frame callback size.
        peer.render_chunks(60_000, 300);
        // A late update, then deactivation.
        peer.queue(late);
        peer.render_chunks(60_000, 300);
        peer.send(GraphCommand::SetSessionClock(None));
        peer.render_chunks(1_000, 300);
    });
    assert_eq!(events, 0, "session clock paths touched the heap");
    let snap = peer.snapshot();
    assert_eq!(snap.last_applied_update_id, 2.0);
    assert_eq!(snap.last_late_update_id, 2.0);
    assert!(
        heap_events(|| drop(std::hint::black_box(Box::new(0u64)))) > 0,
        "the counting allocator records this thread"
    );
}
