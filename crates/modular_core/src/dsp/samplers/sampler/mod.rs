use deserr::Deserr;
use schemars::JsonSchema;

use self::voice::{RELEASE_SLOTS, Ramp, Release, Voice, push_release};
use super::slice::SliceParam;
use crate::{
    Wav,
    dsp::utils::SchmittTrigger,
    param_errors::ModuleParamErrors,
    poly::{MonoSignal, MonoSignalExt, PORT_MAX_CHANNELS, PolyOutput},
};

mod looping;
mod voice;

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
    /// Gate input — rising edge starts playback of the selected window;
    /// with `loop`, holding it high keeps it repeating.
    #[signal(type = gate, range = (0.0, 5.0))]
    gate: MonoSignal,
    /// Playback speed. 1.0 = normal, 2.0 = double speed, negative = reverse.
    #[signal(default = 1.0, range = (-4.0, 4.0))]
    #[deserr(default)]
    speed: Option<MonoSignal>,
    /// Slice selector: a mono signal (whole file as one slice) or
    /// `[points, signal]` where points are fractions of the total length in
    /// [0, 1]. Sampled at each gate rising edge and, while looping, once
    /// per repeat as the pass comes within a fade width of its end: the
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
    /// The current pass's window in WAV frames, picked when the pass
    /// starts. A playing voice keeps it across patch updates.
    win_lo: f64,
    win_hi: f64,
    /// The next loop pass's window, picked as the seam comes in reach.
    next_win: Option<(f64, f64)>,
    /// Declick ramp width in WAV frames (fade seconds × wav rate).
    /// Param+wav-derived, so computed in on_patch_update; 0 disables fades.
    fade_frames: f64,
    /// Retrigger release-voice ramp length in output samples (fade seconds ×
    /// engine rate). Param-derived, so computed in on_patch_update.
    fade_out_samples: u32,
    rels: [Release; RELEASE_SLOTS],
    /// The main pass ends at its window edge instead of repeating: always
    /// for a one-shot, and for a loop pass once the gate falls, `loop` turns
    /// off, or the next slice is empty. Its closing fade is set when this
    /// becomes true. A gate still holding a loop open starts a new pass once
    /// this one is done.
    playing_out: bool,
}

/// One-shot sample player. Each gate rising edge starts playback of the whole
/// file, or of one slice when `slice` is set: the slice signal is sampled at
/// the edge — integer part picks the slice point (wrapping), fraction offsets
/// the start into it. Speed control allows pitch-shifting and reverse
/// playback (a slice plays the same region backwards). A short `fade`
/// (milliseconds) declicks onsets, slice ends, and retriggers. With `loop`,
/// the window repeats for as long as the gate stays high, picking the slice
/// again for each repeat.
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

        let gate_val = self.params.gate.get_value();
        let (gate_high, edge) = self.state.gate_trigger.process_with_edge(gate_val);
        let speed = self.params.speed.value_or(1.0) as f64;
        let advance = speed * self.state.rate_ratio;
        if edge.is_rising() {
            // Demote the current voice to a release voice so the jump to
            // the new onset crossfades instead of clicking. `playing` lags
            // the position by one sample (the span-exit check runs after
            // edge detection), so also require the position to still be in
            // the span: an exited voice is silent and must not displace a
            // live release. The gate was low on the previous sample, so a
            // loop pass already has its closing fade.
            if self.state.playing && self.state.main.in_span() && self.state.fade_out_samples > 0 {
                let release =
                    Release::new(self.state.main, true, self.state.fade_out_samples, advance);
                push_release(&mut self.state.rels, release);
            }
            let (lo, hi) = self.window(frame_count, max_frame);
            self.start_pass(lo, hi, speed, max_frame);
        }

        let holding = self.params.looping && gate_high;
        if self.state.playing && !self.state.playing_out {
            if holding {
                self.loop_seam(advance, frame_count, max_frame);
            } else {
                self.end_loop(advance, max_frame);
            }
        } else if holding && !self.state.playing {
            // An empty slice has nothing to play; the loop picks up as soon
            // as the slice signal selects one that does.
            let (lo, hi) = self.window(frame_count, max_frame);
            if hi > lo {
                self.start_pass(lo, hi, speed, max_frame);
            }
        }

        let fade = self.state.fade_frames;
        let mut main_gain = 0.0;
        if self.state.playing {
            if self.state.main.in_span() {
                main_gain = self.state.main.gain(fade);
            } else {
                self.state.playing = false;
            }
        }

        let fade_out_samples = self.state.fade_out_samples;
        let mut rel_gains = [0.0; RELEASE_SLOTS];
        for (gain, rel) in rel_gains.iter_mut().zip(&mut self.state.rels) {
            *gain = rel.gain(fade, fade_out_samples);
        }
        let any_rel = self.state.rels.iter().any(|r| r.active);

        if !self.state.playing && !any_rel {
            for ch in 0..channels {
                self.outputs.sample.set(ch, 0.0);
            }
            return;
        }

        let wav = &self.params.wav;
        for ch in 0..channels {
            let samples = wav.channel(ch);
            let mut value = 0.0;
            if self.state.playing {
                // Expected range of wav is -1.0 to 1.0, multiply by 5 to get to oscillator level
                value += self.state.main.read(samples) * 5.0 * main_gain;
            }
            for (rel, &gain) in self.state.rels.iter().zip(&rel_gains) {
                if rel.active {
                    value += rel.voice.read(samples) * 5.0 * gain;
                }
            }
            self.outputs.sample.set(ch, value);
        }

        // Advance positions, compensating for sample rate difference (ratio
        // resolved in on_patch_update).
        if self.state.playing {
            self.state.main.position += advance;
        }
        for rel in &mut self.state.rels {
            rel.advance(advance, fade_out_samples);
        }
    }

    /// Start a fresh main pass over `[lo, hi]`. Reverse playback enters
    /// through the window's far edge: the same audible region, played
    /// backwards.
    fn start_pass(&mut self, lo: f64, hi: f64, speed: f64, max_frame: f64) {
        self.state.win_lo = lo;
        self.state.win_hi = hi;
        self.state.next_win = None;
        self.state.main = Voice {
            position: if speed < 0.0 { hi } else { lo },
            lo,
            hi,
            lo_ramp: Ramp::Fade,
            hi_ramp: Ramp::Fade,
            wrap_reads: hi > max_frame,
        };
        // Both edges fade by default. A loop pass sounds at full gain up to
        // the edge it heads for instead: the seam's crossfade, or the
        // play-out fade, sets that ramp.
        if self.params.looping {
            if speed < 0.0 {
                self.state.main.lo_ramp = Ramp::Frames(0.0);
            } else {
                self.state.main.hi_ramp = Ramp::Frames(0.0);
            }
        }
        self.state.playing = true;
        self.state.playing_out = !self.params.looping;
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
mod tests;
