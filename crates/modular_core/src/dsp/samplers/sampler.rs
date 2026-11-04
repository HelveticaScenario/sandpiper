use deserr::Deserr;
use schemars::JsonSchema;

use super::slice::SliceParam;
use crate::{
    Wav,
    dsp::utils::SchmittTrigger,
    param_errors::ModuleParamErrors,
    poly::{MonoSignal, MonoSignalExt, PORT_MAX_CHANNELS, PolyOutput},
};

/// Output width follows the WAV, capped at the port-wide channel limit — a
/// WAV header can claim any u16 channel count.
fn sampler_derive_channel_count(params: &SamplerParams) -> usize {
    params.wav.channel_count().clamp(1, PORT_MAX_CHANNELS)
}

fn default_fade() -> f64 {
    1.0
}

/// Upper bound on the declick fade time.
const MAX_FADE_MS: f64 = 1000.0;

#[derive(Clone, Deserr, JsonSchema, Connect, ChannelCount, SignalParams)]
#[serde(rename_all = "camelCase")]
#[deserr(rename_all = camelCase, deny_unknown_fields, validate = sampler_validate_params -> ModuleParamErrors)]
struct SamplerParams {
    wav: Wav,
    /// Gate input — rising edge starts playback from the beginning; with
    /// `loop`, holding it high keeps the window repeating.
    #[signal(type = gate, range = (0.0, 5.0))]
    gate: MonoSignal,
    /// Playback speed. 1.0 = normal, 2.0 = double speed, negative = reverse.
    #[signal(default = 1.0, range = (-4.0, 4.0))]
    #[deserr(default)]
    speed: Option<MonoSignal>,
    /// Slice selector: a mono signal (whole file as one slice) or
    /// `[points, signal]` where points are fractions of the total length in
    /// [0, 1]. Sampled at each gate rising edge and each loop repeat: the
    /// integer part picks the slice (wrapping), the fraction offsets the
    /// start into it.
    #[deserr(default)]
    slice: Option<SliceParam>,
    /// Declick fade in milliseconds: fade-in at onset, fade-out at the window
    /// exit edge, and retrigger crossfade. 0 disables.
    #[serde(default = "default_fade")]
    #[deserr(default = default_fade())]
    fade: f64,
    /// Repeat while the gate is high (default false): each time a pass
    /// reaches its window's end, the slice is picked again and the next pass
    /// starts on time, so passes never drift. With a fade, the crossfade
    /// uses the audio just before the next window (after it in reverse),
    /// topped up by letting the old pass run on past its end. When the gate
    /// falls or the next slice is empty, the current pass plays out.
    #[serde(default, rename = "loop")]
    #[deserr(default, rename = "loop")]
    looping: bool,
}

fn sampler_validate_params(
    params: SamplerParams,
    _location: deserr::ValuePointerRef,
) -> Result<SamplerParams, ModuleParamErrors> {
    if !params.fade.is_finite() || params.fade < 0.0 || params.fade > MAX_FADE_MS {
        let mut err = ModuleParamErrors::default();
        err.add(
            "fade".to_string(),
            format!("fade must be between 0 and {MAX_FADE_MS} milliseconds"),
        );
        return Err(err);
    }
    Ok(params)
}

#[derive(Outputs, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SamplerOutputs {
    #[output("output", "sample playback output", default)]
    sample: PolyOutput,
}

/// One playback head: a position, the span it may sound in, and a declick
/// ramp at each end of that span.
#[derive(Clone, Copy, Default)]
struct Voice {
    position: f64,
    /// The voice ends once its position leaves `[lo, hi]`.
    lo: f64,
    hi: f64,
    /// Gain rises linearly from 0 at an edge to 1 this many frames inside
    /// it. Position-based, so the ramps are symmetric under reverse and
    /// fade time scales with |speed|; 0 is a hard edge.
    lo_ramp: f64,
    hi_ramp: f64,
    /// Reads wrap around the file end, so the last frame runs on into the
    /// first. Set for loops whose window reaches the end of the file.
    wrap_reads: bool,
}

impl Voice {
    /// NaN comparisons are false, so a non-finite position counts as
    /// outside — a voice can always end.
    fn in_span(&self) -> bool {
        self.position >= self.lo && self.position <= self.hi
    }

    /// Spans shorter than their two ramps peak below unity.
    fn gain(&self) -> f32 {
        let ramp = |d: f64, r: f64| {
            if r > 0.0 {
                (d / r).clamp(0.0, 1.0)
            } else {
                1.0
            }
        };
        ramp(self.position - self.lo, self.lo_ramp).min(ramp(self.hi - self.position, self.hi_ramp))
            as f32
    }

    fn read(&self, wav: &Wav, ch: usize) -> f32 {
        if self.wrap_reads {
            wav.read_hermite_wrapped(ch, self.position as f32)
        } else {
            wav.read_hermite_clamped(ch, self.position as f32)
        }
    }
}

#[derive(Default)]
struct SamplerState {
    main: Voice,
    playing: bool,
    gate_trigger: SchmittTrigger,
    /// Engine sample rate, captured in init.
    sample_rate: f32,
    /// wav_rate / engine_rate. The WAV's sample rate only resolves after
    /// connect(), so this is computed in on_patch_update, not init. Constant
    /// until the next patch update.
    rate_ratio: f64,
    /// Playback window in WAV frames, sampled at the gate rising edge. A
    /// playing voice keeps its trigger-time window across patch updates.
    win_lo: f64,
    win_hi: f64,
    /// Declick ramp width in WAV frames (fade seconds × wav rate).
    /// Param+wav-derived, so computed in on_patch_update; 0 disables fades.
    fade_frames: f64,
    /// Retrigger release-voice ramp length in output samples (fade seconds ×
    /// engine rate). Param-derived, so computed in on_patch_update.
    fade_out_samples: u32,
    /// Release voice: on a retrigger or a loop seam the previous playback
    /// keeps sounding at a fading gain so the jump doesn't click.
    rel_active: bool,
    rel: Voice,
    rel_countdown: u32,
    /// Whether the main voice repeats at its window edge. Set at onset when
    /// looping, cleared for good when the gate falls or the next window is
    /// empty, so one pass plays out.
    loop_armed: bool,
    /// Whether the release voice also ramps down over `fade_out_samples`.
    /// A loop-seam release fades by its span ramp alone, which mirrors the
    /// new pass's fade-in so the two sum to unity.
    rel_timed: bool,
}

/// One-shot sample player. Each gate rising edge starts playback of the whole
/// file, or of one slice when `slice` is set: the slice signal is sampled at
/// the edge — integer part picks the slice point (wrapping), fraction offsets
/// the start into it. Speed control allows pitch-shifting and reverse
/// playback (a slice plays the same region backwards). A short `fade`
/// (milliseconds) declicks onsets, slice ends, and retriggers. With `loop`,
/// the window repeats for as long as the gate stays high.
///
/// ```js
/// $sampler($wavs().kick, $pulse('4hz'))
/// $sampler($wavs().pad, $clock.beatTrigger, { speed: 0.5 })
/// $sampler($wavs().pad, $pulse('2hz'), { slice: [[0, 0.25, 0.5, 0.75], $cycle($p('0 1 2 3')).cv], fade: 2 })
/// $sampler($wavs().pad, $pulse('0.5hz'), { loop: true, fade: 10 })
/// ```
#[module(name = "$sampler", channels_derive = sampler_derive_channel_count, args(wav, gate), has_init, patch_update)]
pub struct Sampler {
    params: SamplerParams,
    outputs: SamplerOutputs,
    state: SamplerState,
}

impl Sampler {
    /// Capture the engine sample rate. Invoked by the `#[module]` proc macro at
    /// construction. The playback rate ratio is finished in on_patch_update,
    /// once the WAV is connected.
    fn init(&mut self, sample_rate: f32) {
        self.state.sample_rate = sample_rate;
    }

    fn update(&mut self, _sample_rate: f32) {
        let channels = self.channel_count();
        let frame_count = self.params.wav.frame_count();

        if !self.params.wav.is_loaded() || frame_count == 0 {
            for ch in 0..channels {
                self.outputs.sample.set(ch, 0.0);
            }
            return;
        }
        let max_frame = (frame_count - 1) as f64;
        let w = self.state.fade_frames;

        let gate_val = self.params.gate.get_value();
        let (gate_high, edge) = self.state.gate_trigger.process_with_edge(gate_val);
        let speed = self.params.speed.value_or(1.0) as f64;
        let advance = speed * self.state.rate_ratio;
        if edge.is_rising() {
            // Demote the current voice to the release voice so the jump to
            // the new onset crossfades instead of clicking. A retrigger
            // during an active release simply steals the slot. `playing`
            // lags the position by one sample (the span-exit check runs
            // after edge detection), so also require the position to still
            // be in the span: an exited voice is silent and must not
            // displace a live release.
            if self.state.playing && self.state.main.in_span() && self.state.fade_out_samples > 0 {
                self.state.rel = self.state.main;
                self.state.rel_countdown = self.state.fade_out_samples;
                self.state.rel_timed = true;
                self.state.rel_active = true;
            }
            let (lo, hi) = self.window(frame_count, max_frame);
            self.state.win_lo = lo;
            self.state.win_hi = hi;
            // Reverse playback enters through the window's far edge: the same
            // audible region, played backwards.
            self.state.main = Voice {
                position: if speed < 0.0 { hi } else { lo },
                lo,
                hi,
                lo_ramp: w,
                hi_ramp: w,
                wrap_reads: hi > max_frame,
            };
            self.state.playing = true;
            self.state.loop_armed = self.params.looping;
        }

        if self.state.loop_armed && self.state.playing {
            if gate_high && self.params.looping {
                self.loop_seam(advance, frame_count, max_frame);
            } else {
                self.state.loop_armed = false;
                self.end_loop(advance, max_frame);
            }
        }

        let mut main_gain = 0.0;
        if self.state.playing {
            if self.state.main.in_span() {
                main_gain = self.state.main.gain();
            } else {
                self.state.playing = false;
            }
        }

        let mut rel_gain = 0.0;
        if self.state.rel_active {
            if (self.state.rel_timed && self.state.rel_countdown == 0) || !self.state.rel.in_span()
            {
                self.state.rel_active = false;
            } else {
                // Time-based ramp-down bounds the ring-out to the fade time
                // regardless of speed; clamped because a patch update can
                // shrink fade_out_samples mid-release.
                let t = if self.state.rel_timed {
                    (self.state.rel_countdown as f64 / self.state.fade_out_samples.max(1) as f64)
                        .min(1.0) as f32
                } else {
                    1.0
                };
                rel_gain = self.state.rel.gain() * t;
            }
        }

        if !self.state.playing && !self.state.rel_active {
            for ch in 0..channels {
                self.outputs.sample.set(ch, 0.0);
            }
            return;
        }

        let wav = &self.params.wav;
        for ch in 0..channels {
            let mut value = 0.0;
            if self.state.playing {
                // Expected range of wav is -1.0 to 1.0, multiply by 5 to get to oscillator level
                value += self.state.main.read(wav, ch) * 5.0 * main_gain;
            }
            if self.state.rel_active {
                value += self.state.rel.read(wav, ch) * 5.0 * rel_gain;
            }
            self.outputs.sample.set(ch, value);
        }

        // Advance positions, compensating for sample rate difference (ratio
        // resolved in on_patch_update).
        if self.state.playing {
            self.state.main.position += advance;
        }
        if self.state.rel_active {
            self.state.rel.position += advance;
            self.state.rel_countdown = self.state.rel_countdown.saturating_sub(1);
        }
    }

    /// The playback window in WAV frames for the slice signal's current
    /// value, or the whole file without a slice.
    fn window(&self, frame_count: usize, max_frame: f64) -> (f64, f64) {
        match &self.params.slice {
            Some(slice) => {
                // A cable can carry non-finite values; fall back to the first
                // slice so the window and position stay finite.
                let s = slice.signal.get_value_f64();
                let s = if s.is_finite() { s } else { 0.0 };
                let n = slice.points.len();
                let idx = (s.floor() as i64).rem_euclid(n as i64) as usize;
                let frac = s - s.floor();
                let start_p = slice.points[idx];
                // Slice ends at the next point, or the end of the file for
                // the last one; an unsorted successor clamps to a zero-length
                // slice.
                let end_p = if idx + 1 < n {
                    slice.points[idx + 1]
                } else {
                    1.0
                };
                let end_p = end_p.clamp(0.0, 1.0).max(start_p);
                let slice_lo = (start_p * frame_count as f64).min(max_frame);
                let slice_hi = end_p * frame_count as f64;
                // A looping window ends exactly where the next slice (or the
                // file) begins, so the repeat period is the slice length.
                let slice_hi = if self.params.looping {
                    slice_hi
                } else {
                    slice_hi.min(max_frame)
                };
                (slice_lo + frac * (slice_hi - slice_lo), slice_hi)
            }
            None if self.params.looping => (0.0, frame_count as f64),
            None => (0.0, max_frame),
        }
    }

    /// Repeat at the window edge the main voice is heading for. The next
    /// pass enters the next window exactly when the old pass reaches the
    /// edge, so the period is the window length. Around that instant they
    /// crossfade: the next pass fades in over `pre` frames of audio outside
    /// the next window's entry edge, and the old pass, as the release voice,
    /// fades out over the same frames plus `post` frames run on past its
    /// edge. The two ramps sum to unity. Each side is capped by the audio the
    /// file has there and by half of either window, so a crossfade always
    /// ends before the next seam.
    fn loop_seam(&mut self, advance: f64, frame_count: usize, max_frame: f64) {
        let (lo, hi) = (self.state.win_lo, self.state.win_hi);
        if hi <= lo || advance == 0.0 {
            return;
        }
        let (next_lo, next_hi) = self.window(frame_count, max_frame);
        let next_span = next_hi - next_lo;
        if next_span <= 0.0 {
            self.state.loop_armed = false;
            self.end_loop(advance, max_frame);
            return;
        }
        let forward = advance > 0.0;
        let w = self.state.fade_frames;
        let cap = w.min((hi - lo).min(next_span) * 0.5);
        let main = &mut self.state.main;
        let (pre_room, post_room) = match (forward, main.wrap_reads) {
            (true, true) => (next_lo, f64::INFINITY),
            (true, false) => (next_lo, max_frame - hi),
            (false, true) => (0.0, f64::INFINITY),
            (false, false) => ((max_frame - next_hi).max(0.0), lo),
        };
        let pre = cap.min(pre_room);
        let post = (cap - pre).min(post_room.max(0.0));
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

    /// When the loop ends, its current pass plays out with the full fade at
    /// the edge it is heading for. Its gain on that side is unity (a seam
    /// ramp hands over to the release voice as soon as it starts),
    /// so the ramp starts at the current position at the latest; when the
    /// edge is closer than a fade width, the voice runs past it into the
    /// audio that follows, as far as the file allows.
    fn end_loop(&mut self, advance: f64, max_frame: f64) {
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

impl crate::types::PatchUpdateHandler for Sampler {
    fn on_patch_update(&mut self) {
        // wav.sample_rate() is only valid after connect() resolves the WAV data,
        // so the rate ratio is computed here rather than in init.
        let wav_rate = self.params.wav.sample_rate() as f64;
        let engine_rate = self.state.sample_rate as f64;
        self.state.rate_ratio = if wav_rate > 0.0 && engine_rate > 0.0 {
            wav_rate / engine_rate
        } else {
            1.0
        };
        let fade_secs = self.params.fade / 1000.0;
        self.state.fade_frames = fade_secs * wav_rate;
        self.state.fade_out_samples = (fade_secs * engine_rate).round() as u32;
    }
}

message_handlers!(impl Sampler {});

#[cfg(test)]
mod tests {
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

    fn make_sliced(
        id: &str,
        wav_data: Arc<WavData>,
        extra: serde_json::Value,
    ) -> Box<dyn Sampleable> {
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
            params_with(
                json!({ "gate": 5.0, "fade": 0.0, "loop": true, "slice": [[0.0, 0.5], 0.0] }),
            ),
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
        let mut params =
            json!({ "gate": 5.0, "fade": 1.0, "loop": true, "slice": [[0.1, 0.2], 0.0] });
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
        // No audio precedes the file start, so the old pass runs on past the
        // end; reads wrap, so the overlap is the head itself and the output
        // is the file repeating sample for sample.
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
    fn empty_next_slice_ends_the_loop_with_a_fade() {
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
        assert!(!sampler.state.loop_armed);
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
            params_with(
                json!({ "gate": 5.0, "fade": 1.0, "loop": true, "slice": [[0.5, 0.75], 0.0] }),
            ),
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
}
