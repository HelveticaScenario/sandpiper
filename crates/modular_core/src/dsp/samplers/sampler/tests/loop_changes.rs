use serde_json::json;

use super::*;

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
fn gate_falling_mid_seam_fades_out_smoothly() {
    let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({}));
    // The first seam starts at sample 432; drop the gate 10 samples in.
    run(&mut sampler, 442);
    assert!(releasing(&sampler));
    set_gate(&mut sampler, 0.0);
    // The seam release and the new pass's release ramp never sum above
    // unity; once the two fall together the slope is at most two ramps'
    // worth, and the output reaches silence within the fade.
    let out = run(&mut sampler, 60);
    let mut prev = 1.0;
    for (i, &v) in out.iter().enumerate() {
        assert!(
            v <= prev + 1e-6 && prev - v <= 2.0 / 48.0 + 1e-6,
            "sample {i}: step from {prev} to {v}"
        );
        prev = v;
    }
    assert_eq!(*out.last().unwrap(), 0.0);
    assert!(!sampler.state.playing);
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

#[test]
fn retrigger_near_a_whole_file_loop_end_fades_out() {
    let wav_data = make_test_wav(vec![vec![0.2; 480]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 1.0, "loop": true })),
        wav_data,
    );
    run(&mut sampler, 470);
    set_gate(&mut sampler, 0.0);
    let mut out = run(&mut sampler, 1);
    set_gate(&mut sampler, 5.0);
    out.extend(run(&mut sampler, 100));
    let step = max_step(1.0, &out);
    assert!(step < 1.0 / 40.0, "step of {step}");
}

#[test]
fn a_one_sample_empty_slice_mid_pass_keeps_the_loop_on_time() {
    let wav = ramp_wav();
    let mut sampler = mid_slice_loop(wav.clone(), json!({}));
    let points = [0.1, 0.2, 0.2];
    set_slice(&mut sampler, &points, 0.0);
    let mut out = run(&mut sampler, 100);
    // Slice 1 is empty.
    set_slice(&mut sampler, &points, 1.0);
    out.extend(run(&mut sampler, 1));
    set_slice(&mut sampler, &points, 0.0);
    out.extend(run(&mut sampler, 480 * 3));
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
fn speed_reversing_mid_seam_never_doubles_the_output() {
    let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({}));
    // The first seam's crossfade runs over samples 432..480.
    run(&mut sampler, 442);
    assert!(releasing(&sampler));
    sampler.params.speed = Some(MonoSignal::from_poly(PolySignal::mono(Signal::Volts(-1.0))));
    let out = run(&mut sampler, 1000);
    for (i, &v) in out.iter().enumerate() {
        assert!(v <= 1.0 + 1e-3, "sample {i}: {v} exceeds unity");
    }
}

#[test]
fn retrigger_during_a_seam_keeps_the_seam_release() {
    let mut sampler = mid_slice_loop(vec![0.2; 4800], json!({}));
    let mut out = run(&mut sampler, 442);
    set_gate(&mut sampler, 0.0);
    out.extend(run(&mut sampler, 1));
    set_gate(&mut sampler, 5.0);
    out.extend(run(&mut sampler, 1));
    assert_eq!(release_positions(&sampler).len(), 2);
    out.extend(run(&mut sampler, 200));
    let step = max_step(out[100], &out[101..]);
    assert!(step < 1.0 / 20.0, "step of {step}");
}
