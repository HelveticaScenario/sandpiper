use serde_json::json;

use super::*;

#[test]
fn loop_repeats_whole_file_with_exact_period() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 0.0, "mode": "loop" })),
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
            json!({ "gate": 5.0, "fade": 0.0, "mode": "loop", "slice": [[0.0, 0.5], 0.0] }),
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
        params_with(json!({ "gate": 5.0, "speed": -1.0, "fade": 0.0, "mode": "loop" })),
        wav_data,
    );
    // Reverse enters at the window end, one past the last frame, which
    // reads the file start; every pass is exactly four frames.
    let out = run(&mut sampler, 9);
    assert_close(&out, &[1.0, 4.0, 3.0, 2.0, 1.0, 4.0, 3.0, 2.0, 1.0]);
}

#[test]
fn loop_stops_when_gate_falls() {
    let wav_data = make_test_wav(vec![vec![0.2, 0.4, 0.6, 0.8]]);
    let mut sampler = make_direct(
        params_with(json!({ "gate": 5.0, "fade": 0.0, "mode": "loop" })),
        wav_data,
    );
    let out = run(&mut sampler, 5);
    assert_close(&out, &[1.0, 2.0, 3.0, 4.0, 1.0]);
    set_gate(&mut sampler, 0.0);
    // Without a fade, playback stops on the sample the gate falls.
    let out = run(&mut sampler, 4);
    assert_close(&out, &[0.0, 0.0, 0.0, 0.0]);
    assert!(!sampler.state.playing);
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
        params_with(json!({ "gate": 5.0, "fade": 1.0, "mode": "loop" })),
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
            assert!(!releasing(&sampler), "speed {speed}: no crossfade");
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
fn window_shorter_than_the_fade_still_loops() {
    // A 4-frame window with a 1 ms fade caps the crossfade at the window
    // length, so every pass still advances through the window.
    let wav_data = make_test_wav(vec![vec![0.2; 16]]);
    let mut sampler = make_direct(
        params_with(
            json!({ "gate": 5.0, "fade": 1.0, "mode": "loop", "slice": [[0.5, 0.75], 0.0] }),
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
