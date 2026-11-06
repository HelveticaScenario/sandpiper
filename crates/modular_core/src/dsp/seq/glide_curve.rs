//! Easing shapes for `$cycle` glides. Every shape starts on the held pitch,
//! ends on the target and never leaves the range between them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Shape of a glide ramp.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GlideCurve {
    #[default]
    Linear,
    Sine,
    Quad,
    Cubic,
    Quart,
    Quint,
    Expo,
    Circ,
    Bounce,
}

/// Which end of the ramp the curve eases. `Linear` ignores it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GlideMode {
    #[default]
    In,
    Out,
    InOut,
}

/// A glide's curve and mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GlideEase {
    pub curve: GlideCurve,
    pub mode: GlideMode,
}

impl GlideEase {
    /// Eased progress for linear progress `t`; both in `[0, 1]`.
    pub fn apply(self, t: f32) -> f32 {
        use GlideCurve::*;
        use GlideMode::*;
        use simple_easing as e;
        if t <= 0.0 {
            return 0.0;
        }
        if t >= 1.0 {
            return 1.0;
        }
        match (self.curve, self.mode) {
            (Linear, _) => t,
            (Sine, In) => e::sine_in(t),
            (Sine, Out) => e::sine_out(t),
            (Sine, InOut) => e::sine_in_out(t),
            (Quad, In) => e::quad_in(t),
            (Quad, Out) => e::quad_out(t),
            (Quad, InOut) => e::quad_in_out(t),
            (Cubic, In) => e::cubic_in(t),
            (Cubic, Out) => e::cubic_out(t),
            (Cubic, InOut) => e::cubic_in_out(t),
            (Quart, In) => e::quart_in(t),
            (Quart, Out) => e::quart_out(t),
            (Quart, InOut) => e::quart_in_out(t),
            (Quint, In) => e::quint_in(t),
            (Quint, Out) => e::quint_out(t),
            (Quint, InOut) => e::quint_in_out(t),
            (Expo, In) => e::expo_in(t),
            (Expo, Out) => e::expo_out(t),
            (Expo, InOut) => e::expo_in_out(t),
            (Circ, In) => e::circ_in(t),
            (Circ, Out) => e::circ_out(t),
            (Circ, InOut) => e::circ_in_out(t),
            (Bounce, In) => e::bounce_in(t),
            (Bounce, Out) => e::bounce_out(t),
            (Bounce, InOut) => e::bounce_in_out(t),
        }
        .clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURVES: [GlideCurve; 9] = [
        GlideCurve::Linear,
        GlideCurve::Sine,
        GlideCurve::Quad,
        GlideCurve::Cubic,
        GlideCurve::Quart,
        GlideCurve::Quint,
        GlideCurve::Expo,
        GlideCurve::Circ,
        GlideCurve::Bounce,
    ];
    const MODES: [GlideMode; 3] = [GlideMode::In, GlideMode::Out, GlideMode::InOut];

    #[test]
    fn every_shape_runs_from_start_to_target_within_range() {
        for curve in CURVES {
            for mode in MODES {
                let ease = GlideEase { curve, mode };
                assert_eq!(ease.apply(0.0), 0.0, "{ease:?} starts on the held pitch");
                assert_eq!(ease.apply(1.0), 1.0, "{ease:?} ends on the target");
                for i in 0..=1000 {
                    let y = ease.apply(i as f32 / 1000.0);
                    assert!((0.0..=1.0).contains(&y), "{ease:?} leaves range: {y}");
                }
                let near_start = ease.apply(1e-6);
                let near_end = ease.apply(1.0 - 1e-6);
                assert!(
                    near_start < 0.01,
                    "{ease:?} jumps at the start: {near_start}"
                );
                assert!(near_end > 0.99, "{ease:?} jumps at the end: {near_end}");
            }
        }
    }

    #[test]
    fn in_eases_the_start_and_out_eases_the_end() {
        let quad = |mode| GlideEase {
            curve: GlideCurve::Quad,
            mode,
        };
        assert!(quad(GlideMode::In).apply(0.25) < 0.25);
        assert!(quad(GlideMode::Out).apply(0.25) > 0.25);
        assert!((quad(GlideMode::InOut).apply(0.5) - 0.5).abs() < 1e-6);
    }
}
