//! Audio-thread tests for the session clock: `at_bar` updates, the shared bar
//! count, session-clock starts, and allocation freedom of those paths.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use modular_core::types::{ClockMessages, Message, ROOT_CLOCK_ID};

use super::tests::{build_root_clock, create_test_processor, insert_running_root_clock};
use super::*;
use crate::session_clock::{SessionClockConfig, SessionTimeline, split_bar};

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

const SR: f32 = 44_100.0;
/// Host time of every captured buffer in these tests.
const HOST: i64 = 1_000_000;
/// Frames per bar at 120 BPM in 4/4.
const BAR_FRAMES: usize = 88_200;

/// A 120 BPM 4/4 timeline at bar `bar` on the buffer's first frame.
fn config_at_bar(bar: f64) -> SessionClockConfig {
    SessionClockConfig {
        offset_micros: 0,
        timeline: SessionTimeline {
            anchor_micros: HOST,
            anchor_bar: bar,
            bpm: 120.0,
            bar_beats: 4.0,
        },
        pending: None,
    }
}

fn activate(cmd: &mut CommandProducer, p: &mut AudioProcessor, config: SessionClockConfig) {
    cmd.push(GraphCommand::SetSessionClock(Some((
        config,
        rusty_link::HostTimeFilter::new(),
    ))))
    .unwrap();
    p.process_commands();
    p.session.capture_at(HOST, SR);
}

fn queue(cmd: &mut CommandProducer, p: &mut AudioProcessor, update: PatchUpdate) {
    cmd.push(GraphCommand::QueuedPatchUpdate {
        update,
        trigger: QueuedTrigger::NextBar,
    })
    .unwrap();
    p.process_commands();
}

fn at_bar_update(update_id: u64, at_bar: i64) -> PatchUpdate {
    let mut update = PatchUpdate::new(SR);
    update.update_id = update_id;
    update.at_bar = Some(at_bar);
    update
}

/// Bar number at cpal frame `f` of the captured buffer.
fn bar_at(p: &AudioProcessor, f: usize) -> i64 {
    split_bar(p.session.bar_position(f).unwrap()).1
}

/// Run `frames` frames of one callback through the path the audio callback
/// takes at block size 1: scan for the queued update's swap, apply it, and
/// fill ROOT_CLOCK under the external clock. Returns the swap's cpal frame.
fn run_callback(p: &mut AudioProcessor, frames: usize) -> Option<usize> {
    let mut swapped = None;
    for written in 0..frames {
        for module in p.patch.sampleables.values() {
            module.start_block();
        }
        p.block_pos = 0;
        if p.queued_update.is_none() {
            p.eager_fill_clock(0, 1, written);
        } else if p.scan_queued_trigger(1, written) == Some(0) {
            let (update, _) = p.queued_update.take().unwrap();
            p.transport_meter.write_applied_update_id(update.update_id);
            p.apply_patch_update_at_frame(update, 0, written);
            if let Some(clock) = p.patch.sampleables.get(&*ROOT_CLOCK_ID) {
                clock.set_initial_index(0);
            }
            p.eager_fill_clock(0, 1, written);
            swapped = Some(written);
        }
        p.block_pos = 1;
    }
    swapped
}

fn clock_bar_index(p: &AudioProcessor) -> f32 {
    p.patch
        .sampleables
        .get(&*ROOT_CLOCK_ID)
        .unwrap()
        .get_value_at("playhead", 1, 0)
}

#[test]
fn at_bar_update_applies_on_its_bar() {
    let (mut cmd, mut p) = create_test_processor();
    activate(&mut cmd, &mut p, config_at_bar(3.75));
    queue(&mut cmd, &mut p, at_bar_update(1, 4));

    let swap = run_callback(&mut p, BAR_FRAMES / 4 + 100).expect("update applies");
    assert_eq!(bar_at(&p, swap), 4);
    assert_eq!(bar_at(&p, swap - 1), 3);
    let snap = p.transport_meter.snapshot();
    assert_eq!(snap.last_applied_update_id, 1.0);
    assert_eq!(snap.last_late_update_id, 0.0);
}

#[test]
fn late_at_bar_update_applies_at_the_next_bar_and_is_reported() {
    let (mut cmd, mut p) = create_test_processor();
    activate(&mut cmd, &mut p, config_at_bar(4.25));
    queue(&mut cmd, &mut p, at_bar_update(7, 4));

    let swap = run_callback(&mut p, BAR_FRAMES * 3 / 4 + 100).expect("update applies");
    assert_eq!(bar_at(&p, swap), 5);
    assert_eq!(bar_at(&p, swap - 1), 4);
    let snap = p.transport_meter.snapshot();
    assert_eq!(snap.last_applied_update_id, 7.0);
    assert_eq!(snap.last_late_update_id, 7.0);
}

#[test]
fn newer_at_bar_update_replaces_the_queued_one_and_keeps_its_bar() {
    let (mut cmd, mut p) = create_test_processor();
    activate(&mut cmd, &mut p, config_at_bar(3.75));
    queue(&mut cmd, &mut p, at_bar_update(1, 6));
    queue(&mut cmd, &mut p, at_bar_update(2, 4));

    let (queued, trigger) = p.queued_update.as_ref().unwrap();
    assert_eq!(queued.update_id, 2);
    assert!(matches!(trigger, QueuedTrigger::NextBar));

    // Not applied immediately: it waits for its own bar.
    assert_eq!(run_callback(&mut p, 1), None);
    p.session.capture_at(HOST, SR);
    let swap = run_callback(&mut p, BAR_FRAMES / 4 + 100).expect("update applies");
    assert_eq!(bar_at(&p, swap), 4);
    assert_eq!(bar_at(&p, swap - 1), 3);
    assert_eq!(p.transport_meter.snapshot().last_applied_update_id, 2.0);
}

#[test]
fn reset_clock_at_bar_counts_the_song_from_that_bar() {
    let (mut cmd, mut p) = create_test_processor();
    insert_running_root_clock(&mut p);
    activate(&mut cmd, &mut p, config_at_bar(3.75));

    let mut update = at_bar_update(1, 4);
    update.reset_clock = true;
    update
        .new_patch
        .sampleables
        .insert(ROOT_CLOCK_ID.to_string(), build_root_clock(p.block_size));
    update.new_patch.rebuild_message_listeners();
    queue(&mut cmd, &mut p, update);

    let swap = run_callback(&mut p, BAR_FRAMES / 4 + 10).expect("update applies");
    assert_eq!(bar_at(&p, swap), 4);
    assert_eq!(clock_bar_index(&p), 0.0);

    // One bar later every peer's clock reads bar index 1.
    p.session.capture_at(HOST, SR);
    run_callback(&mut p, BAR_FRAMES / 4 + BAR_FRAMES + 10);
    assert_eq!(clock_bar_index(&p), 1.0);
    assert_eq!(
        p.session
            .frame(BAR_FRAMES / 4 + BAR_FRAMES + 5)
            .unwrap()
            .bar_index,
        Some(1)
    );
}

#[test]
fn session_clock_owns_the_meter_tempo() {
    let (mut cmd, mut p) = create_test_processor();
    activate(&mut cmd, &mut p, config_at_bar(0.0));
    let mut update = PatchUpdate::new(SR);
    update.transport_meta = Some(TransportMeta {
        tempo: 90.0,
        numerator: 3,
        denominator: 4,
        tempo_set: true,
    });
    p.apply_patch_update(update, 0);
    let snap = p.transport_meter.snapshot();
    assert_eq!(snap.bpm, 120.0);
    assert_eq!(snap.time_sig_numerator, 3);
}

#[test]
fn start_at_bar_waits_for_its_bar() {
    let (mut cmd, mut p) = create_test_processor();
    activate(&mut cmd, &mut p, config_at_bar(3.75));
    cmd.push(GraphCommand::StartAtBar(4)).unwrap();
    p.process_commands();
    assert!(p.is_stopped());
    assert!(!p.session.check_pending_start_release());

    // Half a second later the timeline reaches bar 4.
    p.session.add_samples(BAR_FRAMES as u64 / 4);
    p.session.capture_at(HOST + 500_000, SR);
    assert!(p.session.check_pending_start_release());
    assert_eq!(p.session.frame(0).unwrap().bar_index, Some(0));
}

#[test]
fn deactivating_clears_root_clock_external_sync() {
    let (mut cmd, mut p) = create_test_processor();
    insert_running_root_clock(&mut p);
    activate(&mut cmd, &mut p, config_at_bar(2.5));
    run_callback(&mut p, 4);
    cmd.push(GraphCommand::SetSessionClock(None)).unwrap();
    p.process_commands();
    assert!(!p.session.is_active());
    assert!(p.external_clock_at_frame(0).is_none());
}

#[cfg(not(feature = "alloc-detector"))]
#[test]
fn session_clock_paths_do_not_touch_the_heap() {
    let (mut cmd, mut p) = create_test_processor();
    insert_running_root_clock(&mut p);
    activate(&mut cmd, &mut p, config_at_bar(3.75));
    // Warm the clock and the filter's point buffer.
    run_callback(&mut p, 16);

    let mut update = at_bar_update(1, 4);
    update.reset_clock = true;
    update
        .new_patch
        .sampleables
        .insert(ROOT_CLOCK_ID.to_string(), build_root_clock(p.block_size));
    update.new_patch.rebuild_message_listeners();
    cmd.push(GraphCommand::QueuedPatchUpdate {
        update,
        trigger: QueuedTrigger::NextBar,
    })
    .unwrap();
    let mut refined = config_at_bar(3.75);
    refined.offset_micros = 120;
    refined.pending = Some(SessionTimeline {
        anchor_micros: HOST + 2_500_000,
        anchor_bar: 5.0,
        bpm: 140.0,
        bar_beats: 4.0,
    });
    cmd.push(GraphCommand::SetSessionClock(Some((
        refined,
        rusty_link::HostTimeFilter::new(),
    ))))
    .unwrap();
    cmd.push(GraphCommand::StartAtBar(5)).unwrap();

    let events = heap_events(|| {
        p.process_commands();
        let _ = crate::session_clock::session_clock_micros();
        p.session.capture_at(HOST, SR);
        assert!(!p.session.check_pending_start_release());
        p.session.write_meter(&p.transport_meter);
        assert!(run_callback(&mut p, BAR_FRAMES / 4 + 10).is_some());
        // 2.6 s in, past the pending timeline's anchor and start bar 5.
        p.session.add_samples(114_660);
        p.session.capture_at(HOST + 2_600_000, SR);
        assert!(p.session.check_pending_start_release());
        let _ = p
            .patch
            .dispatch_message(&Message::Clock(ClockMessages::Start));
        run_callback(&mut p, 64);
    });
    assert_eq!(events, 0, "session clock paths touched the heap");
    assert!(
        heap_events(|| drop(std::hint::black_box(Box::new(0u64)))) > 0,
        "the counting allocator records this thread"
    );
}
