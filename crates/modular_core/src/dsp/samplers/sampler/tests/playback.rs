use serde_json::json;

use super::*;

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

#[test]
fn mode_param_accepts_once_loop_and_gate() {
    for mode in ["once", "loop", "gate"] {
        assert!(
            try_params(params_with(json!({ "mode": mode }))).is_ok(),
            "{mode}"
        );
    }
    assert!(try_params(params_with(json!({ "mode": "hold" }))).is_err());
    assert!(try_params(params_with(json!({ "loop": true }))).is_err());
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
