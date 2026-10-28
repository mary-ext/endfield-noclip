// the constants and BRDF terms the main pass and the post passes (water) share; prepended to both.

const PI = 3.14159265358979;

// GGX / Trowbridge–Reitz normal distribution, `a2` = roughness⁴
fn ggx_distribution(n_dot_h: f32, a2: f32) -> f32 {
	let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
	return a2 / (PI * d * d);
}

fn fresnel_schlick(f0: vec3f, v_dot_h: f32) -> vec3f {
	let f = pow(1.0 - v_dot_h, 5.0);
	return f0 + (vec3f(1.0) - f0) * f;
}
