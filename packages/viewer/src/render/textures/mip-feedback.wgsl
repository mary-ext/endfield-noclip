// reduces the main pass's mip feedback (`pack_mip_feedback` in frame.wgsl) to the finest footprint each
// material's UV sets were sampled with: per look slot, two words holding the largest quarter-level count plus
// 1 (0 for a set no sampled pixel reported). one pixel of each `STRIDE`² block is read, the one `offset` picks,
// which the caller moves every frame so that every pixel is read over `STRIDE`² frames.

struct Params {
	// which pixel of each block to read
	offset: vec2u,
	// look slots `seen` has room for
	looks: u32,
}

const STRIDE = 4u;

@group(0) @binding(0) var feedback: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> seen: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn cs_reduce(@builtin(global_invocation_id) id: vec3u) {
	let px = id.xy * STRIDE + params.offset;
	if (any(px >= textureDimensions(feedback))) {
		return;
	}
	let packed = textureLoad(feedback, px, 0).x;
	let look = packed & 0x1ffffu;
	if ((packed & 0x80000000u) == 0u || look >= params.looks) {
		return;
	}
	atomicMax(&seen[look * 2u], ((packed >> 17u) & 127u) + 1u);
	atomicMax(&seen[look * 2u + 1u], ((packed >> 24u) & 127u) + 1u);
}
