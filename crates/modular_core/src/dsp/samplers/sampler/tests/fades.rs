use serde_json::json;

use super::*;

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

#[test]
fn retrigger_crossfades_without_discontinuity() {
    // On a constant-amplitude wav the old voice's release ramp and the new
    // voice's ramp-up hold a constant sum across the whole crossfade: unity
    // in once mode, and in gate mode unity less the one frame the old voice
    // faded while the gate was low.
    for (mode, sum) in [("once", 1.0), ("gate", 47.0 / 48.0)] {
        let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
        let mut sampler = make_direct(
            params_with(json!({ "gate": 5.0, "fade": 1.0, "mode": mode })),
            wav_data,
        );
        // Run past the 48-sample fade-in; steady state is unity (0.2 × 5).
        run(&mut sampler, 100);
        assert!((sampler.outputs.sample.get(0) - 1.0).abs() < 1e-4);

        // Drop the gate below the Schmitt low threshold, then retrigger.
        set_gate(&mut sampler, 0.0);
        sampler.update(SAMPLE_RATE);
        set_gate(&mut sampler, 5.0);
        for (i, v) in run(&mut sampler, 48).into_iter().enumerate() {
            assert!(
                (v - sum).abs() < 1e-3,
                "{mode}, crossfade sample {i}: expected ~{sum}, got {v}"
            );
        }
        run(&mut sampler, 10);
        assert!(!releasing(&sampler), "release voice should be spent");
        assert!((sampler.outputs.sample.get(0) - 1.0).abs() < 1e-4);
    }
}

#[test]
fn once_mode_plays_through_when_the_gate_falls() {
    let wav_data = make_test_wav(vec![vec![0.2; 480]]);
    let mut sampler = make_direct(params_with(json!({ "gate": 5.0, "fade": 1.0 })), wav_data);
    run(&mut sampler, 100);
    set_gate(&mut sampler, 0.0);
    let out = run(&mut sampler, 300);
    assert!(
        out.iter().all(|&v| (v - 1.0).abs() < 1e-4),
        "the pass must play on"
    );
    assert!(sampler.state.playing);
}

#[test]
fn gate_falling_never_releases_an_exited_voice_over_a_live_release() {
    // Slice 0 spans frames 0..48; slice 1 spans frames 48..4799.
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(
        params_with(
            json!({ "gate": 5.0, "mode": "gate", "fade": 2.0, "slice": [[0.0, 0.01], 1.0] }),
        ),
        wav_data,
    );
    // Voice A: long slice 1, run well into its window, then released.
    run(&mut sampler, 200);
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    // Voice B: short slice 0, run to the sample where its position has
    // exited the window but `playing` has not yet been cleared.
    set_slice_signal(&mut sampler, 0.0);
    set_gate(&mut sampler, 5.0);
    run(&mut sampler, 49);
    assert!(
        sampler.state.playing && sampler.state.main.position > sampler.state.main.hi,
        "setup must reach the stale-playing sample"
    );
    // A falling edge exactly there: A's release keeps fading, and the dead
    // voice B never takes a slot.
    set_gate(&mut sampler, 0.0);
    sampler.update(SAMPLE_RATE);
    let positions = release_positions(&sampler);
    assert_eq!(positions.len(), 1, "the dead voice B must not take a slot");
    assert!(
        positions[0] > 100.0,
        "the release must still be the long voice, got {positions:?}"
    );
    let v = sampler.outputs.sample.get(0);
    assert!(
        v > 0.3,
        "release must stay audible across the edge, got {v}"
    );
}

#[test]
fn a_third_overlapping_release_replaces_the_quietest() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(params_with(json!({ "gate": 5.0, "fade": 1.0 })), wav_data);
    let retrigger = |sampler: &mut Sampler| {
        set_gate(sampler, 0.0);
        sampler.update(SAMPLE_RATE);
        set_gate(sampler, 5.0);
        sampler.update(SAMPLE_RATE);
    };
    run(&mut sampler, 100);
    // Voice A (~frame 100) and then voice B (~frame 10) are released.
    retrigger(&mut sampler);
    run(&mut sampler, 10);
    retrigger(&mut sampler);
    assert_eq!(release_positions(&sampler).len(), 2);
    run(&mut sampler, 10);
    // B was released during its onset fade-in, so it is the quietest and
    // the third release (voice C, ~frame 10) replaces it.
    retrigger(&mut sampler);
    let mut positions = release_positions(&sampler);
    positions.sort_by(f64::total_cmp);
    assert_eq!(positions.len(), 2);
    assert!(
        positions[0] < 20.0 && positions[1] > 100.0,
        "expected voices C and A, got {positions:?}"
    );
}

#[test]
fn fade_change_reaches_a_pass_already_playing() {
    let wav_data = make_test_wav(vec![vec![0.2; 480]]);
    let mut sampler = make_direct(params_with(json!({ "gate": 5.0, "fade": 0.0 })), wav_data);
    run(&mut sampler, 100);
    sampler.params.fade = 1.0;
    sampler.on_patch_update();
    let out = run(&mut sampler, 400);
    let step = max_step(1.0, &out);
    assert!(
        step < 1.0 / 40.0,
        "the pass must end with a fade, step {step}"
    );
    assert_eq!(*out.last().unwrap(), 0.0);
}

#[test]
fn gate_mode_fades_out_when_the_gate_falls() {
    for speed in [1.0, -1.0] {
        let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
        let mut sampler = make_direct(
            params_with(json!({ "gate": 5.0, "mode": "gate", "fade": 1.0, "speed": speed })),
            wav_data,
        );
        run(&mut sampler, 200);
        set_gate(&mut sampler, 0.0);
        // A linear 48-frame ramp down from unity, then silence.
        let out = run(&mut sampler, 60);
        for (i, &v) in out.iter().enumerate() {
            let want = (1.0 - i as f32 / 48.0).max(0.0);
            assert!(
                (v - want).abs() < 1e-3,
                "speed {speed}, sample {i}: expected {want}, got {v}"
            );
        }
        assert!(!sampler.state.playing);
    }
}

#[test]
fn gate_mode_without_a_fade_stops_when_the_gate_falls() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8, 0.2, 0.4]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "mode": "gate", "fade": 0.0 })),
        wav_data,
    );
    assert_close(&run(&mut sampler, 2), &[1.0, 2.0]);
    set_gate(&mut sampler, 0.0);
    assert_close(&run(&mut sampler, 3), &[0.0, 0.0, 0.0]);
    assert!(!sampler.state.playing);
}

#[test]
fn gate_falling_in_a_closing_fade_keeps_it_falling() {
    // 480-frame file, 2 ms (96-frame) fade: the closing ramp starts at
    // frame 383. Drop the gate 40 frames into it, at gain ~0.58.
    let wav_data = make_test_wav(vec![vec![0.2; 480]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "mode": "gate", "fade": 2.0 })),
        wav_data,
    );
    let before = run(&mut sampler, 424);
    let prev = *before.last().unwrap();
    set_gate(&mut sampler, 0.0);
    let out = run(&mut sampler, 60);
    let mut last = prev;
    for (i, &v) in out.iter().enumerate() {
        assert!(v <= last + 1e-6, "sample {i}: rose from {last} to {v}");
        last = v;
    }
    assert_eq!(*out.last().unwrap(), 0.0);
}

#[test]
fn gate_release_ends_within_the_fade_when_speed_reverses() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "mode": "gate", "fade": 1.0 })),
        wav_data,
    );
    run(&mut sampler, 2000);
    set_gate(&mut sampler, 0.0);
    run(&mut sampler, 10);
    sampler.params.speed = Some(MonoSignal::from_poly(PolySignal::mono(Signal::Volts(-1.0))));
    let out = run(&mut sampler, 60);
    assert!(
        out.iter().all(|&v| v <= 38.0 / 48.0 + 1e-3),
        "the release must not rise after turning back"
    );
    assert_eq!(*out.last().unwrap(), 0.0);
    assert!(!sampler.state.playing);
}

#[test]
fn gate_falling_on_the_onset_frame_stays_silent() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "mode": "gate", "fade": 1.0 })),
        wav_data,
    );
    run(&mut sampler, 1);
    set_gate(&mut sampler, 0.0);
    let out = run(&mut sampler, 60);
    assert!(out.iter().all(|&v| v < 1.0 / 48.0 + 1e-3), "got {out:?}");
}

#[test]
fn gate_release_ends_within_the_fade_when_speed_slows() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "mode": "gate", "fade": 1.0 })),
        wav_data,
    );
    run(&mut sampler, 200);
    set_gate(&mut sampler, 0.0);
    sampler.params.speed = Some(MonoSignal::from_poly(PolySignal::mono(Signal::Volts(
        0.001,
    ))));
    // 48 samples of fade at 1 ms, however little the voice moves.
    let out = run(&mut sampler, 50);
    assert_eq!(out[48], 0.0, "got {out:?}");
    assert!(!releasing(&sampler));
}

#[test]
fn once_retrigger_crossfade_holds_unity_at_any_speed() {
    for speed in [0.25, 0.5, 2.0, -0.5] {
        let wav_data = make_test_wav(vec![vec![0.2; 48000]]);
        let mut sampler = make_direct(
            params_with(json!({ "gate": 5.0, "fade": 1.0, "speed": speed })),
            wav_data,
        );
        run(&mut sampler, 400);
        set_gate(&mut sampler, 0.0);
        sampler.update(SAMPLE_RATE);
        set_gate(&mut sampler, 5.0);
        for (i, v) in run(&mut sampler, 400).into_iter().enumerate() {
            assert!(
                (v - 1.0).abs() < 1e-3,
                "speed {speed}, sample {i}: expected ~1.0, got {v}"
            );
        }
    }
}

#[test]
fn switching_to_gate_mode_with_the_gate_low_releases_the_pass() {
    let wav_data = make_test_wav(vec![vec![0.2; 4800]]);
    let mut sampler = make_direct(params_with(json!({ "gate": 5.0, "fade": 1.0 })), wav_data);
    run(&mut sampler, 100);
    set_gate(&mut sampler, 0.0);
    run(&mut sampler, 100);
    assert!(
        sampler.state.playing,
        "once mode plays on with the gate low"
    );
    sampler.params.mode = SamplerMode::Gate;
    let out = run(&mut sampler, 60);
    assert_eq!(*out.last().unwrap(), 0.0);
    assert!(!sampler.state.playing);
}
