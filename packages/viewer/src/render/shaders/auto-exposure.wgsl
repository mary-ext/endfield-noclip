// the auto exposure's luminance histogram (auto-exposure.ts): 16 bins of log2 luminance over the metering
// range from every `stride`-th pixel, each sample split linearly between its two nearest bins and optionally
// weighted towards the screen's centre. weights accumulate as fixed point, since WGSL has no float atomics.

struct Params {
	size: vec2u,
	stride: u32,
	// 0 for average metering
	center_weight: f32,
	// log2 luminance of the first bin's start and the last bin's end
	ev_range: vec2f,
}

const BINS = 16u;
const WEIGHT_SCALE = 1024.0;

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> bins: array<atomic<u32>, BINS>;

var<workgroup> local_bins: array<atomic<u32>, BINS>;

@compute @workgroup_size(8, 8)
fn cs_histogram(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) index: u32) {
	if (index < BINS) {
		atomicStore(&local_bins[index], 0u);
	}
	workgroupBarrier();
	let p = id.xy * params.stride;
	if (all(p < params.size)) {
		let color = textureLoad(scene, p, 0).rgb;
		let luminance = max(dot(color, vec3f(0.2126729, 0.7151522, 0.072175)), 0.01);
		let ev = clamp(log2(luminance), params.ev_range.x, params.ev_range.y);
		let x = (ev - params.ev_range.x) / (params.ev_range.y - params.ev_range.x) * (f32(BINS) - 0.0002);
		let bin = min(u32(x), BINS - 1u);
		let next = min(bin + 1u, BINS - 1u);
		let f = fract(x);
		let uv = vec2f(p) / vec2f(params.size) - 0.5;
		let weight = params.center_weight * (exp2(-170.56233 * dot(uv, uv)) - 1.0) + 1.0;
		atomicAdd(&local_bins[bin], u32((1.0 - f) * weight * WEIGHT_SCALE + 0.5));
		atomicAdd(&local_bins[next], u32(f * weight * WEIGHT_SCALE + 0.5));
	}
	workgroupBarrier();
	if (index < BINS) {
		atomicAdd(&bins[index], atomicLoad(&local_bins[index]));
	}
}
