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
    let mut params = serde_json::Map::new();
    params.insert("pattern".to_string(), pattern);
    if let Some(ch) = channels {
        params.insert("channels".to_string(), json!(ch));
    }
    let graph = PatchGraph {
        modules: [
            (
                "ROOT_CLOCK",
                "_clock",
                json!({ "tempo": 48000.0, "numerator": 4, "denominator": 4 }),
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
    for (id, m) in &b.sampleables {
        if let Some(old) = a.sampleables.get(id) {
            m.transfer_state_from(old.as_ref(), &SameIds);
        }
    }
    for m in b.sampleables.values() {
        m.connect(&b);
    }
    for m in b.sampleables.values() {
        m.on_patch_update();
    }

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
