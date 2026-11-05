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
    assert!(!releasing(&sampler), "release voice should be spent");
    assert!((sampler.outputs.sample.get(0) - 1.0).abs() < 1e-4);
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
    assert!(releasing(&sampler));
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
    assert_eq!(
        release_positions(&sampler).len(),
        1,
        "the dead voice B must not take a slot"
    );
    assert!(
        release_positions(&sampler)[0] > 100.0,
        "the release must still be the long voice, got {:?}",
        release_positions(&sampler)
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
