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

fn releasing(sampler: &Sampler) -> bool {
    sampler.state.rels.iter().any(|r| r.active)
}

fn release_positions(sampler: &Sampler) -> Vec<f64> {
    sampler
        .state
        .rels
        .iter()
        .filter(|r| r.active)
        .map(|r| r.voice.position)
        .collect()
}

fn set_slice_signal(sampler: &mut Sampler, volts: f32) {
    sampler.params.slice.as_mut().unwrap().signal =
        MonoSignal::from_poly(PolySignal::mono(Signal::Volts(volts)));
}

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

/// 4800 frames; slice 0 of `[0.1, 0.2]` is the window [480, 960], with
/// audio on both sides of it for the seam crossfade (48 frames at 1 ms).
fn mid_slice_loop(wav: Vec<f32>, extra: serde_json::Value) -> Sampler {
    let mut params =
        json!({ "gate": 5.0, "fade": 1.0, "mode": "loop", "slice": [[0.1, 0.2], 0.0] });
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    make_direct(params_with(params), make_test_wav(vec![wav]))
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

/// Largest sample-to-sample step in `out`, starting from `prev`.
fn max_step(prev: f32, out: &[f32]) -> f32 {
    let mut prev = prev;
    let mut max = 0.0_f32;
    for &v in out {
        max = max.max((v - prev).abs());
        prev = v;
    }
    max
}

mod fades;
mod loop_changes;
mod loop_seams;
mod playback;
