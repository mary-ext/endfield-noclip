// clears one tile of the local lights' shadow atlas: a triangle over the viewport at the far depth, written
// whatever is there (light-shadows.ts)

@vertex
fn vs_clear(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
	let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
	return vec4f(corner * 2.0 - 1.0, 1.0, 1.0);
}

@fragment
fn fs_clear() {}
