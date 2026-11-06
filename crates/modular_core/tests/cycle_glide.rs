//! `$cycle` glides: a note's CV ramp starts `glide` cycles before its onset
//! and lands on the onset.

use std::collections::HashMap;

use modular_core::patch::Patch;
use modular_core::types::{ModuleSpec, PatchGraph, SameIds};
use serde_json::{Value, json};

mod common;
use common::from_graph;

const SAMPLE_RATE: f32 = 48000.0;
/// 48000 BPM in 4/4 at 48 kHz.
const SAMPLES_PER_CYCLE: usize = 240;

fn mini(source: &str) -> Value {
    let parsed = modular_core::dsp::seq::seq_value::ParsedPatternPayload::parse_for_test(source);
    serde_json::to_value(&parsed).expect("payload should serialize")
}

fn glide(pattern: Value, length: Value) -> Value {
    json!({ "__kind": "GlidePattern", "pattern": pattern, "length": length })
}

fn cycle_patch(pattern: Value, channels: Option<u64>) -> Patch {
    cycle_patch_at(pattern, channels, 48000.0)
}

fn cycle_patch_at(pattern: Value, channels: Option<u64>, tempo: f64) -> Patch {
    cycle_patch_with(pattern, channels, tempo, None)
}

fn cycle_patch_with(
    pattern: Value,
    channels: Option<u64>,
    tempo: f64,
    ribbon: Option<(f64, f64)>,
) -> Patch {
    let mut params = serde_json::Map::new();
    if let Some((offset, length)) = ribbon {
        params.insert("ribbon".to_string(), json!([offset, length]));
    }
    params.insert("pattern".to_string(), pattern);
    if let Some(ch) = channels {
        params.insert("channels".to_string(), json!(ch));
    }
    let graph = PatchGraph {
        modules: [
            (
                "ROOT_CLOCK",
                "_clock",
                json!({ "tempo": tempo, "numerator": 4, "denominator": 4 }),
            ),
            ("seq", "$cycle", Value::Object(params)),
        ]
        .into_iter()
        .map(|(id, module_type, params)| ModuleSpec {
            id: id.to_string(),
            module_type: module_type.to_string(),
            id_is_explicit: None,
            skip_state_transfer: None,
            params,
        })
        .collect(),
        module_id_remaps: None,
        scopes: vec![],
        vu_meters: vec![],
    };
    from_graph(&graph, SAMPLE_RATE, 1, &HashMap::new()).expect("from_graph failed")
}

fn process_frame(patch: &Patch) {
    for module in patch.sampleables.values() {
        module.start_block();
    }
    for module in patch.sampleables.values() {
        module.ensure_processed();
    }
}

fn seq_val(patch: &Patch, port: &str, ch: usize) -> f32 {
    patch
        .sampleables
        .get("seq")
        .unwrap()
        .get_value_at(port, ch, 0)
}

/// Per-sample `(cv, trig)` of channel `ch` over `n` frames.
fn trace(patch: &Patch, ch: usize, n: usize) -> Vec<(f32, bool)> {
    (0..n)
        .map(|_| {
            process_frame(patch);
            (seq_val(patch, "cv", ch), seq_val(patch, "trig", ch) > 2.5)
        })
        .collect()
}

/// Sample indices where the trigger rises.
fn onsets(trace: &[(f32, bool)]) -> Vec<usize> {
    (0..trace.len())
        .filter(|&i| trace[i].1 && (i == 0 || !trace[i - 1].1))
        .collect()
}

fn assert_near(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 0.02,
        "{what}: expected {expected}, got {actual}"
    );
}

#[test]
fn glide_ramps_before_the_onset_and_lands_on_it() {
    let patch = cycle_patch(glide(mini("0 1"), json!(0.25)), Some(1));
    let t = trace(&patch, 0, 2 * SAMPLES_PER_CYCLE);
    let on = onsets(&t);
    let second = on[1];
    let quarter = SAMPLES_PER_CYCLE / 4;

    assert_near(t[second - quarter - 2].0, 0.0, "before the glide window");
    assert_near(t[second - quarter / 2].0, 0.5, "halfway through the ramp");
    assert_near(t[second].0, 1.0, "on the onset");
    assert_near(t[second + quarter].0, 1.0, "after the onset");
    for i in (second - quarter)..second {
        assert!(t[i + 1].0 >= t[i].0, "ramp rises monotonically at {i}");
    }
    // The ramp into the next cycle's `0` falls over the last quarter cycle.
    let third = on[2];
    assert_near(t[third - quarter / 2].0, 0.5, "halfway down");
    assert_near(t[third].0, 0.0, "on the next cycle's onset");
}

#[test]
fn glide_length_is_patterned_per_note() {
    // `0` glides in over a quarter cycle; `1` jumps.
    let patch = cycle_patch(glide(mini("0 1"), mini("0.25 0")), Some(1));
    let t = trace(&patch, 0, 2 * SAMPLES_PER_CYCLE);
    let on = onsets(&t);
    assert_near(t[on[1] - 1].0, 0.0, "just before the jump");
    assert_near(t[on[1]].0, 1.0, "on the jump");
    let quarter = SAMPLES_PER_CYCLE / 4;
    assert_near(
        t[on[2] - quarter / 2].0,
        0.5,
        "halfway through the glide into 0",
    );
}

#[test]
fn without_glide_cv_jumps_on_the_onset() {
    let patch = cycle_patch(mini("0 1"), Some(1));
    let t = trace(&patch, 0, SAMPLES_PER_CYCLE);
    let second = onsets(&t)[1];
    assert_near(t[second - 1].0, 0.0, "before the onset");
    assert_near(t[second].0, 1.0, "on the onset");
}

#[test]
fn chord_voices_glide_to_their_nearest_notes() {
    let patch = cycle_patch(glide(mini("[0,2] [1,3]"), json!(0.25)), Some(2));
    let mut cv = [Vec::new(), Vec::new()];
    let mut trig = Vec::new();
    for _ in 0..SAMPLES_PER_CYCLE {
        process_frame(&patch);
        for (ch, trace) in cv.iter_mut().enumerate() {
            trace.push(seq_val(&patch, "cv", ch));
        }
        trig.push(seq_val(&patch, "trig", 0) > 2.5);
    }
    let second = (1..trig.len()).find(|&i| trig[i] && !trig[i - 1]).unwrap();
    let mid = second - SAMPLES_PER_CYCLE / 8;
    let mut halfway = [cv[0][mid], cv[1][mid]];
    halfway.sort_by(f32::total_cmp);
    assert_near(halfway[0], 0.5, "lower voice halfway from 0 to 1");
    assert_near(halfway[1], 2.5, "upper voice halfway from 2 to 3");
    let mut landed = [cv[0][second], cv[1][second]];
    landed.sort_by(f32::total_cmp);
    assert_near(landed[0], 1.0, "lower voice on the onset");
    assert_near(landed[1], 3.0, "upper voice on the onset");
}

#[test]
fn pattern_swap_mid_ramp_reaims_from_the_current_cv() {
    let a = cycle_patch(glide(mini("0 1"), json!(0.25)), Some(1));
    // Playhead at about 0.375: halfway through the ramp into `1` at 0.5.
    let t = trace(&a, 0, SAMPLES_PER_CYCLE * 3 / 8);
    let before_swap = t.last().unwrap().0;
    assert_near(before_swap, 0.5, "halfway before the swap");

    let b = cycle_patch(glide(mini("0 3"), json!(0.25)), Some(1));
    transfer_into(&b, &a);

    let t = trace(&b, 0, SAMPLES_PER_CYCLE / 4);
    assert!(
        (t[0].0 - before_swap).abs() < 0.1,
        "no snap at the swap: {before_swap} then {}",
        t[0].0
    );
    let onset = onsets(&t)[0];
    assert_near(t[onset].0, 3.0, "lands on the new note");
    for i in 0..onset {
        assert!(t[i + 1].0 >= t[i].0, "re-aimed ramp rises at {i}");
    }
}

/// Replicate a live patch update: transfer state, reconnect, `on_patch_update`.
fn transfer_into(new: &Patch, old: &Patch) {
    for (id, m) in &new.sampleables {
        if let Some(prev) = old.sampleables.get(id) {
            m.transfer_state_from(prev.as_ref(), &SameIds);
        }
    }
    for m in new.sampleables.values() {
        m.connect(new);
    }
    for m in new.sampleables.values() {
        m.on_patch_update();
    }
}

#[test]
fn a_glide_waits_for_the_notes_before_its_target() {
    // `2` glides over half a cycle, but `1` plays on the only voice first:
    // every note sounds, `0` holds still, and the ramp into `2` starts on `1`.
    let patch = cycle_patch(glide(mini("0 1 2"), mini("0 0 0.5")), Some(1));
    let t = trace(&patch, 0, SAMPLES_PER_CYCLE);
    let on = onsets(&t);
    assert!(on.len() >= 3, "all three notes fire: {on:?}");
    for (i, sample) in t.iter().enumerate().take(on[1]) {
        assert_near(sample.0, 0.0, &format!("`0` holds still at {i}"));
    }
    assert_near(t[on[1]].0, 1.0, "`1` lands at its onset");
    assert_near(t[(on[1] + on[2]) / 2].0, 1.5, "halfway from `1` to `2`");
    assert_near(t[on[2]].0, 2.0, "`2` lands at its onset");
}

#[test]
fn glides_stay_continuous_on_a_clock_off_the_sample_grid() {
    // About 245.1 samples per cycle, so onsets fall between samples.
    let patch = cycle_patch_at(glide(mini("[0,2] [1,3]"), json!(0.25)), Some(2), 47000.0);
    let mut prev = [None::<f32>; 2];
    let mut rises = 0;
    let mut prev_trig = [false; 2];
    for frame in 0..4 * SAMPLES_PER_CYCLE {
        process_frame(&patch);
        for ch in 0..2 {
            let cv = seq_val(&patch, "cv", ch);
            if let Some(p) = prev[ch]
                && frame > 2
            {
                assert!(
                    (cv - p).abs() < 0.05,
                    "channel {ch} steps from {p} to {cv} at frame {frame}"
                );
            }
            prev[ch] = Some(cv);
            let trig = seq_val(&patch, "trig", ch) > 2.5;
            if trig && !prev_trig[ch] {
                rises += 1;
            }
            prev_trig[ch] = trig;
        }
    }
    assert!(rises >= 14, "every chord note fires: {rises} onsets");
}

#[test]
fn a_ramp_cut_by_a_swap_holds_its_cv_until_the_next_onset() {
    let a = cycle_patch(glide(mini("0 1"), json!(0.25)), Some(1));
    let t = trace(&a, 0, SAMPLES_PER_CYCLE * 3 / 8);
    let at_swap = t.last().unwrap().0;
    assert_near(at_swap, 0.5, "halfway before the swap");

    let b = cycle_patch(mini("0 3"), Some(1));
    transfer_into(&b, &a);
    let t = trace(&b, 0, SAMPLES_PER_CYCLE / 4);
    let onset = onsets(&t)[0];
    for (i, sample) in t.iter().enumerate().take(onset) {
        assert_near(sample.0, at_swap, &format!("held at {i}"));
    }
    assert_near(t[onset].0, 3.0, "jumps to the new note at its onset");
}

#[test]
fn a_stacked_glide_pattern_does_not_duplicate_notes() {
    let patch = cycle_patch(glide(mini("0 1"), mini("[0, 0.25]")), Some(4));
    let mut rises = 0;
    let mut prev = [false; 4];
    for _ in 0..SAMPLES_PER_CYCLE - 1 {
        process_frame(&patch);
        for (ch, prev) in prev.iter_mut().enumerate() {
            let trig = seq_val(&patch, "trig", ch) > 2.5;
            if trig && !*prev {
                rises += 1;
            }
            *prev = trig;
        }
    }
    assert_eq!(rises, 2, "one onset per note");
}

/// Run A (gliding) then B (no glide) then C (gliding), swapping mid-cycle, and
/// return C's CV halfway through its glide window into `3` at 0.5.
fn cv_mid_window_after_two_swaps(keep_a_alive: bool) -> f32 {
    // `0` at 0 glides 0.5 into its next lap, so A's scan at the onset finds no
    // window opening before 0.5.
    let a = cycle_patch(glide(mini("0 ~ ~ ~"), json!(0.5)), Some(1));
    trace(&a, 0, SAMPLES_PER_CYCLE / 10);
    let b = cycle_patch(mini("0 ~ ~ ~"), Some(1));
    transfer_into(&b, &a);
    let kept = keep_a_alive.then_some(a);
    trace(&b, 0, SAMPLES_PER_CYCLE * 2 / 10);
    // `3` at 0.5 glides in from 0.25; the playhead is at 0.3.
    let c = cycle_patch(glide(mini("0 ~ 3 ~"), json!(0.25)), Some(1));
    transfer_into(&c, &b);
    let t = trace(&c, 0, SAMPLES_PER_CYCLE / 10);
    drop(kept);
    t.last().unwrap().0
}

#[test]
fn a_glide_window_open_at_a_swap_is_claimed_after_it() {
    // Freed bakes let later bakes reuse their memory, so repeat the swaps.
    for attempt in 0..20 {
        for keep_a_alive in [true, false] {
            let cv = cv_mid_window_after_two_swaps(keep_a_alive);
            assert!(
                cv > 0.5 && cv < 2.5,
                "attempt {attempt} (A alive: {keep_a_alive}): cv {cv} not ramping"
            );
        }
    }
}

#[test]
fn every_note_glides_with_more_open_windows_than_channels() {
    // Each of 80 notes glides over the whole loop, so more windows are open at
    // once than a `$cycle` has channels, while one voice plays them in turn.
    let notes: Vec<String> = (0..80).map(|n| n.to_string()).collect();
    // A fiftieth of the usual tempo, so each note outlasts its trigger pulse.
    let patch = cycle_patch_at(glide(mini(&notes.join(" ")), json!(1.0)), Some(1), 960.0);
    let t = trace(&patch, 0, 100 * SAMPLES_PER_CYCLE + 1);
    let on = onsets(&t);
    assert_eq!(on.len(), 161, "every note fires");
    for pair in on.windows(2).skip(1) {
        let (from, to) = (t[pair[0]].0, t[pair[1]].0);
        let mid = t[(pair[0] + pair[1]) / 2].0;
        assert!(
            (mid - (from + to) / 2.0).abs() < 0.3,
            "ramp from {from} to {to} sits at {mid} midway"
        );
    }
}

#[test]
fn a_rescan_finds_a_window_that_opened_behind_the_seam() {
    // On a one-cycle loop, `1` at 0.5 glides 0.75, so its window opens at
    // 0.75 of the previous lap. The start and the swap at 0.1 both rescan
    // inside it.
    let pattern = || glide(mini("0 1"), json!(0.75));
    let a = cycle_patch_with(pattern(), Some(1), 48000.0, Some((0.0, 1.0)));
    trace(&a, 0, SAMPLES_PER_CYCLE / 10);
    let b = cycle_patch_with(pattern(), Some(1), 48000.0, Some((0.0, 1.0)));
    transfer_into(&b, &a);
    let t = trace(&b, 0, SAMPLES_PER_CYCLE * 3 / 10);
    let at_swap = t[0].0;
    assert_near(
        t.last().unwrap().0,
        at_swap + (1.0 - at_swap) * 0.75,
        "ramping into `1`",
    );
}

#[test]
fn curve_and_mode_shape_the_ramp() {
    let halfway = |curve: &str, mode: &str| {
        let pattern = json!({
            "__kind": "GlidePattern",
            "pattern": mini("0 1"),
            "length": 0.25,
            "curve": curve,
            "mode": mode,
        });
        let patch = cycle_patch(pattern, Some(1));
        let t = trace(&patch, 0, SAMPLES_PER_CYCLE);
        let onset = onsets(&t)[1];
        (t[onset - SAMPLES_PER_CYCLE / 8].0, t[onset].0)
    };
    for (curve, mode, expected) in [
        ("linear", "out", 0.5),
        ("quad", "in", 0.25),
        ("quad", "out", 0.75),
        ("quad", "inOut", 0.5),
        ("cubic", "in", 0.125),
    ] {
        let (mid, landed) = halfway(curve, mode);
        assert_near(mid, expected, &format!("{curve} {mode} halfway"));
        assert_near(landed, 1.0, &format!("{curve} {mode} on the onset"));
    }
}
