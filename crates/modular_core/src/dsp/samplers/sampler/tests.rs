use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::dsp::{get_constructors, get_params_deserializers};
use crate::params::DeserializedParams;
use crate::patch::Patch;
use crate::poly::PolySignal;
use crate::types::{
    Connect, OutputStruct, PatchUpdateHandler, SampleBuffer, Sampleable, Signal, WavData,
};

const SAMPLE_RATE: f32 = 48000.0;

fn make_module(module_type: &str, id: &str, params: serde_json::Value) -> Box<dyn Sampleable> {
    let constructors = get_constructors();
    let deserializers = get_params_deserializers();
    let deserializer = deserializers
        .get(module_type)
        .unwrap_or_else(|| panic!("no params deserializer for '{module_type}'"));
    let cached = deserializer(params)
        .unwrap_or_else(|e| panic!("params deserialization for '{module_type}' failed: {e}"));
    let deserialized = DeserializedParams {
        params: cached.params,
        channel_count: cached.channel_count,
    };
    constructors
        .get(module_type)
        .unwrap_or_else(|| panic!("no constructor for '{module_type}'"))(
        &id.to_string(),
        SAMPLE_RATE,
        deserialized,
        TEST_BLOCK_SIZE,
        crate::types::ProcessingMode::Block,
    )
    .unwrap_or_else(|e| panic!("constructor for '{module_type}' failed: {e}"))
}

/// Block size used at construction by every test in this module. Bumping
/// this exercises the wrapper's per-block dispatch — `Stepper` walks all
/// `TEST_BLOCK_SIZE` slots between `start_block` calls.
const TEST_BLOCK_SIZE: usize = 1;

/// Per-sample cursor that hides block boundaries from tests. Each
/// `tick()` returns the slot index to read; when the cursor wraps past
/// `TEST_BLOCK_SIZE`, it triggers a new `start_block` + `ensure_processed`.
struct Stepper {
    slot: usize,
}

impl Stepper {
    fn new() -> Self {
        // Initialise out-of-range so the first tick triggers a block.
        Self {
            slot: TEST_BLOCK_SIZE,
        }
    }

    /// Advance one sample. Returns the slot index to read this frame's
    /// outputs from. Multiple reads in the same frame (e.g. L+R of a
    /// stereo output) share the returned slot.
    fn tick(&mut self, module: &dyn Sampleable) -> usize {
        if self.slot >= TEST_BLOCK_SIZE {
            module.start_block();
            module.ensure_processed();
            self.slot = 0;
        }
        let s = self.slot;
        self.slot += 1;
        s
    }
}

fn make_test_wav(samples: Vec<Vec<f32>>) -> Arc<WavData> {
    Arc::new(WavData::new(
        SampleBuffer::from_samples(samples, SAMPLE_RATE),
        None,
    ))
}

#[test]
fn sampler_outputs_silence_when_not_triggered() {
    let wav_data = make_test_wav(vec![vec![1.0, 2.0, 3.0, 4.0]]);
    let module = make_module(
        "$sampler",
        "s1",
        serde_json::json!({
            "wav": { "type": "wav_ref", "path": "test", "channels": 1 },
            "gate": 0.0,
            "speed": 1.0,
            "fade": 0.0,
        }),
    );

    // Connect with wav_data in patch
    let mut patch = Patch::new();
    patch.wav_data.insert("test".to_string(), wav_data);
    module.connect(&patch);
    module.on_patch_update();

    // Run a few samples — no trigger, should output silence
    let mut s = Stepper::new();
    let mut last = 0;
    for _ in 0..4 {
        last = s.tick(module.as_ref());
    }
    assert_eq!(module.get_value_at("output", 0, last), 0.0);
}

#[test]
fn sampler_plays_on_gate_rising_edge() {
    // 4-frame mono WAV with values in -1..1 range (output is scaled by 5.0)
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let module = make_module(
        "$sampler",
        "s2",
        serde_json::json!({
            "wav": { "type": "wav_ref", "path": "test", "channels": 1 },
            "gate": 5.0,
            "speed": 1.0,
            "fade": 0.0,
        }),
    );

    let mut patch = Patch::new();
    patch.wav_data.insert("test".to_string(), wav_data);
    module.connect(&patch);
    module.on_patch_update();

    // First tick: gate is high, Schmitt trigger detects rising edge, position resets to 0
    // 0.2 * 5.0 = 1.0
    let mut s = Stepper::new();
    let slot = s.tick(module.as_ref());
    let v = module.get_value_at("output", 0, slot);
    assert!((v - 1.0).abs() < 1e-6, "expected 1.0, got {v}");
}

#[test]
fn sampler_outputs_silence_after_sample_ends() {
    let wav_data = make_test_wav(vec![vec![1.0, 2.0]]);
    let module = make_module(
        "$sampler",
        "s3",
        serde_json::json!({
            "wav": { "type": "wav_ref", "path": "test", "channels": 1 },
            "gate": 5.0,
            "speed": 1.0,
            "fade": 0.0,
        }),
    );

    let mut patch = Patch::new();
    patch.wav_data.insert("test".to_string(), wav_data);
    module.connect(&patch);
    module.on_patch_update();

    // Play through the 2-frame sample
    let mut s = Stepper::new();
    s.tick(module.as_ref()); // frame 0 -> output 1.0
    s.tick(module.as_ref()); // frame 1 -> output 2.0
    let slot = s.tick(module.as_ref()); // frame 2 -> past end -> silence
    assert_eq!(
        module.get_value_at("output", 0, slot),
        0.0,
        "should be silent after sample ends"
    );
}

#[test]
fn sampler_plays_reverse_with_negative_speed() {
    // 4-frame mono WAV in -1..1 range (output scaled by 5.0)
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let module = make_module(
        "$sampler",
        "s_rev",
        serde_json::json!({
            "wav": { "type": "wav_ref", "path": "test", "channels": 1 },
            "gate": 5.0,
            "speed": -1.0,
            "fade": 0.0,
        }),
    );

    let mut patch = Patch::new();
    patch.wav_data.insert("test".to_string(), wav_data);
    module.connect(&patch);
    module.on_patch_update();

    // With negative speed, gate trigger should start from end of sample.
    // Frame 3 = 0.8*5=4.0, frame 2 = 0.6*5=3.0, frame 1 = 0.4*5=2.0, frame 0 = 0.2*5=1.0
    let mut s = Stepper::new();
    let expected = [4.0_f32, 3.0, 2.0, 1.0];
    for (i, &want) in expected.iter().enumerate() {
        let slot = s.tick(module.as_ref());
        let v = module.get_value_at("output", 0, slot);
        assert!(
            (v - want).abs() < 1e-6,
            "reverse frame {i}: expected {want}, got {v}"
        );
    }

    let slot = s.tick(module.as_ref());
    assert_eq!(
        module.get_value_at("output", 0, slot),
        0.0,
        "should be silent after reverse playback ends"
    );
}

#[test]
fn sampler_plays_stereo_wav() {
    // 3-frame stereo WAV in -1..1 range (output scaled by 5.0)
    // L=[0.2, 0.4, 0.6], R=[0.8, 1.0, -0.4]
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6], vec![0.8, 1.0, -0.4]]);
    let module = make_module(
        "$sampler",
        "s4",
        serde_json::json!({
            "wav": { "type": "wav_ref", "path": "stereo", "channels": 2 },
            "gate": 5.0,
            "speed": 1.0,
            "fade": 0.0,
        }),
    );

    let mut patch = Patch::new();
    patch.wav_data.insert("stereo".to_string(), wav_data);
    module.connect(&patch);
    module.on_patch_update();

    let mut s = Stepper::new();

    // First tick: gate rises, plays frame 0
    // L: 0.2*5=1.0, R: 0.8*5=4.0
    let slot = s.tick(module.as_ref());
    let l = module.get_value_at("output", 0, slot);
    let r = module.get_value_at("output", 1, slot);
    assert!((l - 1.0).abs() < 1e-6, "L ch should be 1.0, got {l}");
    assert!((r - 4.0).abs() < 1e-6, "R ch should be 4.0, got {r}");

    // Second tick: frame 1
    // L: 0.4*5=2.0, R: 1.0*5=5.0
    let slot = s.tick(module.as_ref());
    let l = module.get_value_at("output", 0, slot);
    let r = module.get_value_at("output", 1, slot);
    assert!((l - 2.0).abs() < 1e-6, "L ch should be 2.0, got {l}");
    assert!((r - 5.0).abs() < 1e-6, "R ch should be 5.0, got {r}");
}

// === slice/fade param deserialization ===

fn try_params(params: serde_json::Value) -> Result<(), String> {
    let deserializers = get_params_deserializers();
    let de = deserializers
        .get("$sampler")
        .expect("no params deserializer for $sampler");
    de(params).map(|_| ()).map_err(|e| e.to_string())
}

fn params_with(extra: serde_json::Value) -> serde_json::Value {
    let mut v = json!({
        "wav": { "type": "wav_ref", "path": "test", "channels": 1 },
        "gate": 0.0,
    });
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    v
}

#[test]
fn slice_param_accepts_bare_signal_and_tuple_forms() {
    for good in [
        json!(0.5),
        json!([0.0, 1.0]), // poly-array shorthand, summed to mono
        json!([[0.0, 0.5], 1.0]),
        json!([[0.0, 0.25, 0.5, 0.75], { "type": "cable", "module": "m", "port": "p" }]),
    ] {
        let r = try_params(params_with(json!({ "slice": good.clone() })));
        assert!(r.is_ok(), "expected acceptance for slice = {good}: {r:?}");
    }
}

#[test]
fn slice_param_rejects_malformed_forms() {
    for bad in [
        json!([]),
        json!([[], 0.0]),
        json!([[0.0, 1.5], 0.0]),
        json!([[-0.1], 0.0]),
        json!([[0.0]]),
        json!([[0.0], 0.0, 0.0]),
    ] {
        let r = try_params(params_with(json!({ "slice": bad.clone() })));
        assert!(r.is_err(), "expected rejection for slice = {bad}");
    }
}

#[test]
fn fade_param_bounds() {
    assert!(try_params(params_with(json!({}))).is_ok()); // defaulted
    assert!(try_params(params_with(json!({ "fade": 0.0 }))).is_ok());
    assert!(try_params(params_with(json!({ "fade": 1000.0 }))).is_ok());
    assert!(try_params(params_with(json!({ "fade": -1.0 }))).is_err());
    assert!(try_params(params_with(json!({ "fade": 1000.5 }))).is_err());
}

// === slice playback ===

fn make_sliced(id: &str, wav_data: Arc<WavData>, extra: serde_json::Value) -> Box<dyn Sampleable> {
    let module = make_module("$sampler", id, params_with(extra));
    let mut patch = Patch::new();
    patch.wav_data.insert("test".to_string(), wav_data);
    module.connect(&patch);
    module.on_patch_update();
    module
}

fn expect_output(module: &dyn Sampleable, s: &mut Stepper, expected: &[f32]) {
    for (i, &want) in expected.iter().enumerate() {
        let slot = s.tick(module);
        let v = module.get_value_at("output", 0, slot);
        assert!(
            (v - want).abs() < 1e-4,
            "frame {i}: expected {want}, got {v}"
        );
    }
}

#[test]
fn slice_plays_selected_slice() {
    // Slice 1 of [0, 0.5] covers the second half: frames 2, 3, then silence.
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let module = make_sliced(
        "sl1",
        wav_data,
        json!({ "gate": 5.0, "fade": 0.0, "slice": [[0.0, 0.5], 1.0] }),
    );
    expect_output(module.as_ref(), &mut Stepper::new(), &[3.0, 4.0, 0.0]);
}

#[test]
fn slice_index_wraps_including_negatives() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    // 2 wraps to slice 0: frames 0..2 (window hi = 0.5 × 4 = frame 2).
    let module = make_sliced(
        "sl_wrap_pos",
        wav_data.clone(),
        json!({ "gate": 5.0, "fade": 0.0, "slice": [[0.0, 0.5], 2.0] }),
    );
    expect_output(module.as_ref(), &mut Stepper::new(), &[1.0, 2.0, 3.0, 0.0]);
    // -1 wraps to slice 1: frames 2, 3.
    let module = make_sliced(
        "sl_wrap_neg",
        wav_data,
        json!({ "gate": 5.0, "fade": 0.0, "slice": [[0.0, 0.5], -1.0] }),
    );
    expect_output(module.as_ref(), &mut Stepper::new(), &[3.0, 4.0, 0.0]);
}

#[test]
fn slice_fraction_offsets_start_into_slice() {
    // Signal 0.5 on a single whole-file slice: start halfway into the
    // window [0, 4] → frame 2, play to the end.
    let wav_data = make_test_wav(vec![vec![0.1, 0.2, 0.3, 0.4, 0.5]]);
    let module = make_sliced(
        "sl_frac",
        wav_data,
        json!({ "gate": 5.0, "fade": 0.0, "slice": [[0.0], 0.5] }),
    );
    expect_output(module.as_ref(), &mut Stepper::new(), &[1.5, 2.0, 2.5, 0.0]);
}

#[test]
fn slice_reverse_plays_same_window_backwards() {
    // Same window as the fraction test, negative speed: enters at the far
    // edge and exits at the fraction-offset start.
    let wav_data = make_test_wav(vec![vec![0.1, 0.2, 0.3, 0.4, 0.5]]);
    let module = make_sliced(
        "sl_rev",
        wav_data,
        json!({ "gate": 5.0, "speed": -1.0, "fade": 0.0, "slice": [[0.0], 0.5] }),
    );
    expect_output(module.as_ref(), &mut Stepper::new(), &[2.5, 2.0, 1.5, 0.0]);
}

#[test]
fn zero_length_slice_is_silent_with_fade() {
    let wav_data = make_test_wav(vec![vec![0.2; 4]]);
    // Duplicate points and unsorted points both collapse to a zero-length
    // window, which the declick gain keeps silent.
    for (id, points) in [
        ("sl_dup", json!([0.5, 0.5])),
        ("sl_unsorted", json!([0.7, 0.2])),
    ] {
        let module = make_sliced(
            id,
            wav_data.clone(),
            json!({ "gate": 5.0, "fade": 1.0, "slice": [points, 0.0] }),
        );
        expect_output(module.as_ref(), &mut Stepper::new(), &[0.0, 0.0, 0.0]);
    }
}

// === declick fades ===

#[test]
fn fade_ramps_at_onset_and_window_edges() {
    // 480-frame constant wav at 48kHz with a 1ms fade: the ramp width is
    // 48 frames on each side of the window.
    let wav_data = make_test_wav(vec![vec![0.2; 480]]);
    let module = make_sliced("sl_fade", wav_data, json!({ "gate": 5.0, "fade": 1.0 }));
    let mut s = Stepper::new();
    let mut out = Vec::with_capacity(481);
    for _ in 0..481 {
        let slot = s.tick(module.as_ref());
        out.push(module.get_value_at("output", 0, slot));
    }
    for (k, want) in [
        (0, 0.0),   // onset
        (24, 0.5),  // halfway up the ramp
        (48, 1.0),  // ramp complete
        (240, 1.0), // mid-file
        (455, 0.5), // 24 frames from the window edge
        (479, 0.0), // window edge
        (480, 0.0), // past the end
    ] {
        let v = out[k];
        assert!(
            (v - want).abs() < 1e-3,
            "sample {k}: expected {want}, got {v}"
        );
    }
}

// === retrigger crossfade (needs a mutable gate → direct construction) ===

fn make_direct(params_json: serde_json::Value, wav_data: Arc<WavData>) -> Sampler {
    let mut params: SamplerParams = deserr::deserialize::<_, _, ModuleParamErrors>(params_json)
        .unwrap_or_else(|e| panic!("params deserialization failed: {e}"));
    let mut patch = Patch::new();
    patch.wav_data.insert("test".to_string(), wav_data);
    params.connect(&patch);
    let mut outputs = SamplerOutputs::default();
    outputs.set_all_channels(1);
    let mut sampler = Sampler {
        params,
        outputs,
        state: SamplerState::default(),
        _channel_count: 1,
        _block_index: Default::default(),
    };
    sampler.init(SAMPLE_RATE);
    sampler.on_patch_update();
    sampler
}

fn set_gate(sampler: &mut Sampler, volts: f32) {
    sampler.params.gate = MonoSignal::from_poly(PolySignal::mono(Signal::Volts(volts)));
}

#[test]
fn retrigger_crossfades_without_discontinuity() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(params_with(json!({ "gate": 5.0, "fade": 1.0 })), wav_data);
    // Run past the 48-sample fade-in; steady state is unity (0.2 × 5).
    for _ in 0..100 {
        sampler.update(SAMPLE_RATE);
    }
    assert!((sampler.outputs.sample.get(0) - 1.0).abs() < 1e-4);

    // Drop the gate below the Schmitt low threshold, then retrigger.
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    set_gate(&mut sampler, 5.0);

    // On a constant-amplitude wav the old voice's ramp-down and the new
    // voice's ramp-up sum to unity across the whole crossfade.
    for i in 0..48 {
        sampler.update(SAMPLE_RATE);
        let v = sampler.outputs.sample.get(0);
        assert!(
            (v - 1.0).abs() < 1e-3,
            "crossfade sample {i}: expected ~1.0, got {v}"
        );
    }
    for _ in 0..10 {
        sampler.update(SAMPLE_RATE);
    }
    assert!(!sampler.state.rel_active, "release voice should be spent");
    assert!((sampler.outputs.sample.get(0) - 1.0).abs() < 1e-4);
}

#[test]
fn channel_count_clamps_to_port_max() {
    let deserializers = get_params_deserializers();
    let de = deserializers
        .get("$sampler")
        .expect("no params deserializer for $sampler");
    for (channels, want) in [(65535, PORT_MAX_CHANNELS), (0, 1)] {
        let cached = de(json!({
            "wav": { "type": "wav_ref", "path": "test", "channels": channels },
            "gate": 0.0,
        }))
        .expect("params should deserialize");
        assert_eq!(
            cached.channel_count, want,
            "channel count for a {channels}-channel wav"
        );
    }
}

fn set_slice_signal(sampler: &mut Sampler, volts: f32) {
    sampler.params.slice.as_mut().unwrap().signal =
        MonoSignal::from_poly(PolySignal::mono(Signal::Volts(volts)));
}

#[test]
fn non_finite_slice_signal_plays_first_slice_and_window_still_ends() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 0.0, "slice": [[0.0, 0.5], 0.0] })),
        wav_data,
    );
    set_slice_signal(&mut sampler, f32::NAN);
    // The rising edge samples NaN; slice 0 (frames 0..2) plays.
    sampler.update(SAMPLE_RATE);
    let v = sampler.outputs.sample.get(0);
    assert!((v - 1.0).abs() < 1e-6, "expected slice 0 onset, got {v}");
    // Frames 1 and 2, then the position exits the window and the voice
    // clears rather than latching.
    for _ in 0..3 {
        sampler.update(SAMPLE_RATE);
    }
    assert!(
        !sampler.state.playing,
        "voice must clear at the window exit"
    );
    assert_eq!(sampler.outputs.sample.get(0), 0.0);
}

#[test]
fn retrigger_never_demotes_an_exited_voice_over_a_live_release() {
    // Slice 0 spans frames 0..48; slice 1 spans frames 48..4799.
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 2.0, "slice": [[0.0, 0.01], 1.0] })),
        wav_data,
    );
    // Voice A: long slice 1, run well into its window.
    for _ in 0..200 {
        sampler.update(SAMPLE_RATE);
    }
    // Retrigger onto short slice 0: A becomes the release voice, B starts.
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    set_slice_signal(&mut sampler, 0.0);
    set_gate(&mut sampler, 5.0);
    sampler.update(SAMPLE_RATE);
    assert!(sampler.state.rel_active);
    // Run B to the last sample where its position has exited the window
    // but `playing` has not yet been cleared, and land a gate rising
    // edge exactly there.
    for _ in 0..47 {
        sampler.update(SAMPLE_RATE);
    }
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    assert!(
        sampler.state.playing && sampler.state.main.position > sampler.state.main.hi,
        "setup must reach the stale-playing sample"
    );
    set_gate(&mut sampler, 5.0);
    sampler.update(SAMPLE_RATE);
    // A's release keeps fading; the dead voice B never takes the slot.
    assert!(sampler.state.rel_active, "release voice must keep fading");
    assert!(
        sampler.state.rel.position > 100.0,
        "release slot must still hold the long voice, got position {}",
        sampler.state.rel.position
    );
    let v = sampler.outputs.sample.get(0);
    assert!(
        v > 0.3,
        "release must stay audible across the edge, got {v}"
    );
}

#[test]
fn reverse_start_on_a_file_past_f32_range_reads_the_last_frame() {
    // 2^24 + 4 frames: the last index rounds up to the length in f32.
    let n = (1 << 24) + 4;
    let mut wav = vec![0.0; n];
    wav[n - 1] = 0.2;
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "speed": -1.0, "fade": 0.0 })),
        make_test_wav(vec![wav]),
    );
    sampler.update(SAMPLE_RATE);
    let v = sampler.outputs.sample.get(0);
    assert!((v - 1.0).abs() < 1e-6, "expected the last frame, got {v}");
}

// === looping ===

fn run(sampler: &mut Sampler, n: usize) -> Vec<f32> {
    (0..n)
        .map(|_| {
            sampler.update(SAMPLE_RATE);
            sampler.outputs.sample.get(0)
        })
        .collect()
}

fn assert_close(got: &[f32], want: &[f32]) {
    assert_eq!(got.len(), want.len());
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((g - w).abs() < 1e-4, "sample {i}: expected {w}, got {g}");
    }
}

#[test]
fn loop_repeats_whole_file_with_exact_period() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 0.0, "loop": true })),
        wav_data,
    );
    let out = run(&mut sampler, 12);
    assert_close(&out, &[1.0, 2.0, 3.0, 4.0].repeat(3));
}

#[test]
fn loop_repeats_selected_slice() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 0.0, "loop": true, "slice": [[0.0, 0.5], 0.0] })),
        wav_data,
    );
    let out = run(&mut sampler, 6);
    assert_close(&out, &[1.0, 2.0, 1.0, 2.0, 1.0, 2.0]);
}

#[test]
fn loop_repeats_in_reverse() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "speed": -1.0, "fade": 0.0, "loop": true })),
        wav_data,
    );
    // Reverse enters at the window end, one past the last frame, which
    // reads the file start; every pass is exactly four frames.
    let out = run(&mut sampler, 9);
    assert_close(&out, &[1.0, 4.0, 3.0, 2.0, 1.0, 4.0, 3.0, 2.0, 1.0]);
}

#[test]
fn loop_plays_out_and_stops_when_gate_falls() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 0.0, "loop": true })),
        wav_data,
    );
    let out = run(&mut sampler, 5);
    assert_close(&out, &[1.0, 2.0, 3.0, 4.0, 1.0]);
    set_gate(&mut sampler, 0.0);
    // The current pass finishes (the window end reads on into the file
    // start), then the voice stops instead of wrapping.
    let out = run(&mut sampler, 6);
    assert_close(&out, &[2.0, 3.0, 4.0, 1.0, 0.0, 0.0]);
    assert!(!sampler.state.playing);
}

/// 4800 frames; slice 0 of `[0.1, 0.2]` is the window [480, 960], with
/// audio on both sides of it for the seam crossfade (48 frames at 1 ms).
fn mid_slice_loop(wav: Vec<f32>, extra: serde_json::Value) -> Sampler {
    let mut params = json!({ "gate": 5.0, "fade": 1.0, "loop": true, "slice": [[0.1, 0.2], 0.0] });
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    make_direct(params_with(params), make_test_wav(vec![wav]))
}

#[test]
fn loop_seam_crossfade_holds_unity_on_constant_signal() {
    for speed in [1.0, 1.37, -1.0, -1.37] {
        let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({ "speed": speed }));
        // Past the onset ramp, a constant wav stays at unity through
        // several seams.
        let out = run(&mut sampler, 3000);
        for (i, &v) in out.iter().enumerate().skip(48) {
            assert!(
                (v - 1.0).abs() < 1e-3,
                "speed {speed}, sample {i}: expected ~1.0, got {v}"
            );
        }
    }
}

#[test]
fn loop_period_is_exact_with_a_crossfade() {
    // Distinct values per frame: outside each seam crossfade the output is
    // exactly the window frame `k mod 480` samples in, on every pass.
    let wav: Vec<f32> = (0..4800).map(|i| (i % 1000) as f32 / 1000.0).collect();
    let mut sampler = mid_slice_loop(wav.clone(), json!({}));
    let out = run(&mut sampler, 480 * 6);
    for (k, &v) in out.iter().enumerate().skip(480) {
        let phase = k % 480;
        if phase < 480 - 48 {
            let want = wav[480 + phase] * 5.0;
            assert!(
                (v - want).abs() < 1e-4,
                "sample {k}: expected {want}, got {v}"
            );
        }
    }
}

#[test]
fn loop_seam_fades_in_audio_from_before_the_window() {
    let wav: Vec<f32> = (0..4800).map(|i| (i % 1000) as f32 / 1000.0).collect();
    let mut sampler = mid_slice_loop(wav.clone(), json!({}));
    // Halfway through the first seam (sample 456), the tail (frame 936)
    // and the audio 24 frames before the window (frame 456) sound at half
    // gain each.
    let out = run(&mut sampler, 457);
    let want = (wav[936] + wav[456]) * 0.5 * 5.0;
    assert!(
        (out[456] - want).abs() < 1e-4,
        "expected {want}, got {}",
        out[456]
    );
}

#[test]
fn whole_file_loop_is_a_seamless_ring() {
    // The window's end runs on into the file start, so the seam needs no
    // crossfade and the output is the file repeating sample for sample.
    let wav: Vec<f32> = (0..480).map(|i| i as f32 / 480.0).collect();
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 1.0, "loop": true })),
        make_test_wav(vec![wav.clone()]),
    );
    let out = run(&mut sampler, 480 * 4);
    for (k, &v) in out.iter().enumerate().skip(48) {
        let want = wav[k % 480] * 5.0;
        assert!(
            (v - want).abs() < 1e-4,
            "sample {k}: expected {want}, got {v}"
        );
    }
}

/// Ramp wav whose frame values are all distinct within the file.
fn ramp_wav() -> Vec<f32> {
    (0..4800).map(|i| i as f32 / 4800.0).collect()
}

fn set_slice(sampler: &mut Sampler, points: &[f64], volts: f32) {
    let slice = sampler.params.slice.as_mut().unwrap();
    slice.points = points.to_vec();
    slice.signal = MonoSignal::from_poly(PolySignal::mono(Signal::Volts(volts)));
}

#[test]
fn slice_change_takes_effect_at_the_loop_point() {
    let wav = ramp_wav();
    let mut sampler = mid_slice_loop(wav.clone(), json!({}));
    // Window [480, 960]; switch to slice 1, [960, 1440], mid-pass.
    let out = run(&mut sampler, 200);
    set_slice(&mut sampler, &[0.1, 0.2, 0.3], 1.0);
    let out: Vec<f32> = out.into_iter().chain(run(&mut sampler, 1000)).collect();
    // The current pass is untouched until its crossfade starts.
    for k in 48..432 {
        let want = wav[480 + k] * 5.0;
        assert!(
            (out[k] - want).abs() < 1e-4,
            "sample {k}: expected {want}, got {}",
            out[k]
        );
    }
    // The next pass is on time: it reaches 960 at sample 480.
    for k in 480..912 {
        let want = wav[960 + k - 480] * 5.0;
        assert!(
            (out[k] - want).abs() < 1e-4,
            "sample {k}: expected {want}, got {}",
            out[k]
        );
    }
}

#[test]
fn seam_into_the_adjacent_slice_plays_straight_through() {
    // The next window starts where the old pass leaves the audio, so the
    // seam is plain playback with no release voice.
    for (speed, points, from, to) in [
        (1.0, [0.1, 0.2, 0.3], 0.0, 1.0),
        (-1.0, [0.0, 0.1, 0.2], 1.0, 0.0),
    ] {
        let wav = ramp_wav();
        let mut sampler = mid_slice_loop(wav.clone(), json!({ "speed": speed }));
        set_slice(&mut sampler, &points, from);
        let mut out = run(&mut sampler, 1);
        set_slice(&mut sampler, &points, to);
        for _ in 1..900 {
            out.extend(run(&mut sampler, 1));
            assert!(!sampler.state.rel_active, "speed {speed}: no crossfade");
        }
        for (k, &v) in out.iter().enumerate().skip(48) {
            let frame = if speed > 0.0 { 480 + k } else { 960 - k };
            let want = wav[frame] * 5.0;
            assert!(
                (v - want).abs() < 1e-4,
                "speed {speed}, sample {k}: expected {want}, got {v}"
            );
        }
    }
}

#[test]
fn reverse_seam_from_the_last_slice_fades_in_audio_after_the_next_window() {
    // Reverse from [4320, 4800] to [480, 960]: the next pass fades in over
    // the audio just above 960, as in a mid-file seam.
    let wav = ramp_wav();
    let mut sampler = mid_slice_loop(wav.clone(), json!({ "speed": -1.0 }));
    set_slice(&mut sampler, &[0.1, 0.2, 0.9], 2.0);
    sampler.update(SAMPLE_RATE);
    set_slice(&mut sampler, &[0.1, 0.2, 0.9], 0.0);
    let out = run(&mut sampler, 456);
    // Halfway through the seam (sample 456 from the onset), the tail
    // (frame 4344) and the audio 24 frames above the window (frame 984)
    // sound at half gain each.
    let want = (wav[4344] + wav[984]) * 0.5 * 5.0;
    assert!(
        (out[455] - want).abs() < 1e-4,
        "expected {want}, got {}",
        out[455]
    );
}

#[test]
fn seam_runs_on_past_the_end_when_the_next_window_starts_the_file() {
    // From [480, 960] to [0, 480]: nothing precedes the next window, so
    // the old pass fades out over the audio after 960 instead.
    let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({}));
    set_slice(&mut sampler, &[0.0, 0.1, 0.2], 1.0);
    sampler.update(SAMPLE_RATE);
    set_slice(&mut sampler, &[0.0, 0.1, 0.2], 0.0);
    let out = run(&mut sampler, 1500);
    for (i, &v) in out.iter().enumerate().skip(48) {
        assert!((v - 1.0).abs() < 1e-3, "sample {i}: expected ~1.0, got {v}");
    }
    let wav = ramp_wav();
    let mut sampler = mid_slice_loop(wav.clone(), json!({}));
    set_slice(&mut sampler, &[0.0, 0.1, 0.2], 1.0);
    sampler.update(SAMPLE_RATE);
    set_slice(&mut sampler, &[0.0, 0.1, 0.2], 0.0);
    let out = run(&mut sampler, 1000);
    // The next pass enters frame 0 at sample 479 (one sample ran before
    // the run) and is at full gain once the 48-frame overlap ends.
    for k in 527..900 {
        let want = wav[k - 479] * 5.0;
        assert!(
            (out[k] - want).abs() < 1e-4,
            "sample {k}: expected {want}, got {}",
            out[k]
        );
    }
}

#[test]
fn empty_slice_silences_the_loop_until_a_slice_is_selected() {
    let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({}));
    // Slice 1 of [0.1, 0.2, 0.2] is empty.
    run(&mut sampler, 100);
    set_slice(&mut sampler, &[0.1, 0.2, 0.2], 1.0);
    let out = run(&mut sampler, 500);
    let mut prev = out[0];
    for (i, &v) in out.iter().enumerate() {
        assert!(
            (prev - v).abs() < 1.0 / 40.0,
            "sample {i}: step from {prev} to {v}"
        );
        prev = v;
    }
    assert!(!sampler.state.playing);
    // Selecting a non-empty slice again resumes looping without a new
    // gate, fading in from silence.
    set_slice(&mut sampler, &[0.1, 0.2, 0.2], 0.0);
    let out = run(&mut sampler, 1000);
    assert!(sampler.state.playing);
    assert!(out[0].abs() < 1e-6, "pass must fade in, got {}", out[0]);
    assert!(
        (out[500] - 1.0).abs() < 1e-3,
        "expected ~1.0, got {}",
        out[500]
    );
}

#[test]
fn gate_falling_mid_seam_keeps_the_crossfade_smooth() {
    let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({}));
    // The first seam starts at sample 432; drop the gate 10 samples in.
    run(&mut sampler, 442);
    assert!(sampler.state.rel_active);
    set_gate(&mut sampler, 0.0);
    let out = run(&mut sampler, 300);
    for (i, &v) in out.iter().enumerate() {
        assert!((v - 1.0).abs() < 1e-3, "sample {i}: expected ~1.0, got {v}");
    }
}

#[test]
fn gate_falling_near_a_hard_seam_still_fades_out() {
    // The whole-file loop has a hard seam, so its pass is at full gain up
    // to the window end. Drop the gate 10 frames before it: the voice runs
    // on past the end for a full 48-frame fade.
    let wav_data = make_test_wav(vec![vec![0.2; 480]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 1.0, "loop": true })),
        wav_data,
    );
    run(&mut sampler, 470);
    set_gate(&mut sampler, 0.0);
    let out = run(&mut sampler, 60);
    let mut prev = 1.0;
    for (i, &v) in out.iter().enumerate() {
        assert!(
            v <= prev + 1e-6 && prev - v < 1.0 / 40.0,
            "sample {i}: step from {prev} to {v}"
        );
        prev = v;
    }
    assert_eq!(*out.last().unwrap(), 0.0);
    assert!(!sampler.state.playing);
}

#[test]
fn window_shorter_than_the_fade_still_loops() {
    // A 4-frame window with a 1 ms fade caps the crossfade at the window
    // length, so every pass still advances through the window.
    let wav_data = make_test_wav(vec![vec![0.2; 16]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 1.0, "loop": true, "slice": [[0.5, 0.75], 0.0] })),
        wav_data,
    );
    let mut wraps = 0;
    let mut last = sampler.state.main.position;
    for _ in 0..40 {
        sampler.update(SAMPLE_RATE);
        assert!(sampler.outputs.sample.get(0).is_finite());
        if sampler.state.main.position < last {
            wraps += 1;
        }
        last = sampler.state.main.position;
    }
    assert!(sampler.state.playing);
    assert!((8..=11).contains(&wraps), "wraps = {wraps}");
}

#[test]
fn retrigger_during_release_steals_the_slot() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(params_with(json!({ "gate": 5.0, "fade": 1.0 })), wav_data);
    for _ in 0..100 {
        sampler.update(SAMPLE_RATE);
    }
    // First retrigger: the ~100-frame-old voice becomes the release voice.
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    set_gate(&mut sampler, 5.0);
    for _ in 0..10 {
        sampler.update(SAMPLE_RATE);
    }
    // Second retrigger mid-crossfade: the young main voice (position ~12)
    // steals the release slot from the old voice (position ~112).
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    set_gate(&mut sampler, 5.0);
    sampler.update(SAMPLE_RATE);
    assert!(sampler.state.rel_active);
    assert!(
        sampler.state.rel.position < 20.0,
        "release slot should hold the young voice, got position {}",
        sampler.state.rel.position
    );
    assert_eq!(
        sampler.state.rel_countdown,
        sampler.state.fade_out_samples - 1
    );
}

#[test]
fn held_loop_never_stays_silent_under_live_changes() {
    // Sweep speed (through and near zero, both directions), the slice
    // signal (onto empty and unsorted slices), the slice param itself,
    // `loop`, and the fade, with the gate held. Whenever `loop` is on and
    // the selected slice is non-empty, the sampler must be playing
    // within a sample, and the output must stay finite.
    let wav: Vec<f32> = (0..4800).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
    let mut seed: u64 = 0x1234_5678;
    let mut rnd = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let mono = |v: f32| MonoSignal::from_poly(PolySignal::mono(Signal::Volts(v)));
    for trial in 0..60 {
        let mut sampler = mid_slice_loop(wav.clone(), json!({ "fade": 5.0 }));
        let frame_count = 4800;
        let max_frame = 4799.0;
        for step in 0..300 {
            let r = rnd();
            if r < 0.3 {
                let v = match (rnd() * 5.0) as u32 {
                    0 => 0.0,
                    1 => (rnd() - 0.5) * 1e-4,
                    _ => (rnd() - 0.5) * 8.0,
                } as f32;
                sampler.params.speed = Some(mono(v));
            } else if r < 0.6 {
                if sampler.params.slice.is_some() {
                    set_slice_signal(&mut sampler, ((rnd() - 0.3) * 8.0) as f32);
                }
            } else if r < 0.75 {
                sampler.params.slice = if sampler.params.slice.is_some() {
                    None
                } else {
                    let points = match (rnd() * 3.0) as u32 {
                        0 => vec![0.0, 0.25, 0.5, 0.75],
                        1 => vec![0.1, 0.2, 0.2],
                        _ => vec![0.6, 0.3, 0.9],
                    };
                    Some(SliceParam {
                        points,
                        signal: mono((rnd() * 4.0) as f32),
                    })
                };
            } else if r < 0.85 {
                sampler.params.looping = !sampler.params.looping;
            } else {
                sampler.params.fade = rnd() * 20.0;
                sampler.on_patch_update();
            }
            let mut silent_run = 0;
            for _ in 0..(rnd() * 3000.0) as usize + 1 {
                sampler.update(SAMPLE_RATE);
                let v = sampler.outputs.sample.get(0);
                assert!(
                    v.is_finite(),
                    "trial {trial} step {step}: non-finite output"
                );
                let (lo, hi) = sampler.window(frame_count, max_frame);
                if sampler.params.looping && hi > lo && !sampler.state.playing {
                    silent_run += 1;
                    assert!(
                        silent_run <= 1,
                        "trial {trial} step {step}: held loop stopped over a non-empty slice"
                    );
                } else {
                    silent_run = 0;
                }
            }
        }
    }
}
