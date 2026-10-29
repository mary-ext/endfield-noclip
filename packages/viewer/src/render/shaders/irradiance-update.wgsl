// fills one level of the irradiance clipmap from the resident cells: the game's IrradianceVolumeUpdateV3CS
// (FullUpdateClipmap0..2), with a window of resident cells in place of its top-level hash. one invocation per
// texel; texel t holds the probe whose index along each axis is congruent to t modulo the clipmap's size, so
// the clipmap is toroidal and the lighting samples it with a repeating sampler.

struct Update {
	// xyz: probe index (in this level's spacing) of the clipmap's centre, w: level
	centre: vec4i,
	// xyz: cell index (p >> (6 + level)) of the window's minimum corner, w: the window's first word in `windows`
	window: vec4i,
	// xyz: window size in cells
	window_size: vec4i,
}

@group(0) @binding(0) var<uniform> update: Update;
// resident cells, each a copy of an irradiance cell blob at a word offset
@group(0) @binding(1) var<storage, read> cells: array<u32>;
// per window cell: the cell's first word in `cells` plus one, or 0 when it isn't resident
@group(0) @binding(2) var<storage, read> windows: array<u32>;
// L0 rgb
@group(0) @binding(3) var out_a: texture_storage_3d<rgba16float, write>;
// three slabs along y (red, green, blue): the L1 direction · 0.25 + 0.5, alpha the probe's validity
@group(0) @binding(4) var out_b: texture_storage_3d<rgba8unorm, write>;

const SIZE = vec3i(128, 64, 128);
// probe units are 0.5 m with world 0 at 8192 (the game's half extent, 4096 m)
const ORIGIN = 8192;

fn modulo(a: vec3i, n: vec3i) -> vec3i {
	return ((a % n) + n) % n;
}

// the probe's first word in `cells`, or -1 where the cell has none at p
fn find_probe(cell: u32, p: vec3i, level: i32) -> i32 {
	let t = i32(cells[cell]);
	let o = i32(cells[cell + 1u]);
	let block = (p & vec3i((64 << u32(level)) - 1)) >> vec3u(u32(2 + 2 * level));
	let sub = (p >> vec3u(u32(2 * level))) & vec3i(3);
	let bit = u32((((sub.x << 2u) | sub.x) & 9) | (((sub.y << 3u) | (sub.y << 1u)) & 18) | (((sub.z << 4u) | (sub.z << 2u)) & 36));
	let oi = block % vec3i(o);
	let offset = cells[cell + 2u + u32(oi.x + oi.y * o + oi.z * o * o)];
	let h = (block + vec3i(i32(offset & 255u), i32((offset >> 8u) & 255u), i32((offset >> 16u) & 255u))) % vec3i(t);
	let entry = cell + 2u + u32(o * o * o) + u32(h.x + h.y * t + h.z * t * t) * 4u;
	if (cells[entry] != u32(block.x | (block.y << 8u) | (block.z << 16u))) {
		return -1;
	}
	let lo = cells[entry + 2u];
	let hi = cells[entry + 3u];
	var below: u32;
	if (bit < 32u) {
		if (((lo >> bit) & 1u) == 0u) {
			return -1;
		}
		below = countOneBits(lo & ((1u << bit) - 1u));
	} else {
		if (((hi >> (bit - 32u)) & 1u) == 0u) {
			return -1;
		}
		below = countOneBits(lo) + countOneBits(hi & ((1u << (bit - 32u)) - 1u));
	}
	return i32(cell + (cells[entry + 1u] >> 2u) + below * 4u);
}

@compute @workgroup_size(4, 4, 4)
fn cs_update(@builtin(global_invocation_id) id: vec3u) {
	let texel = vec3i(id);
	if (any(texel >= SIZE)) {
		return;
	}
	let level = update.centre.w;
	let lowest = update.centre.xyz - SIZE / 2;
	let index = lowest + modulo(texel - lowest, SIZE);
	let p = index * (1 << u32(2 * level)) + vec3i(ORIGIN);

	var a = vec4f(0.0);
	var b0 = vec4f(0.0);
	var b1 = vec4f(0.0);
	var b2 = vec4f(0.0);
	let w = (p >> vec3u(u32(6 + level))) - update.window.xyz;
	let size = update.window_size.xyz;
	if (all(p >= vec3i(0)) && all(w >= vec3i(0)) && all(w < size)) {
		let slot = windows[u32(update.window.w + w.x + w.y * size.x + w.z * size.x * size.y)];
		if (slot != 0u) {
			let at = find_probe(slot - 1u, p, level);
			if (at >= 0) {
				let word = cells[at];
				// R11G11B10F through half floats, as the game does
				a = vec4f(
					unpack2x16float((word << 4u) & 0x7ff0u).x,
					unpack2x16float((word >> 7u) & 0x7ff0u).x,
					unpack2x16float((word >> 17u) & 0x7fe0u).x,
					0.0,
				);
				b0 = unpack4x8unorm(cells[at + 1]);
				b1 = unpack4x8unorm(cells[at + 2]);
				b2 = unpack4x8unorm(cells[at + 3]);
			}
		}
	}
	textureStore(out_a, texel, a);
	textureStore(out_b, texel, b0);
	textureStore(out_b, texel + vec3i(0, SIZE.y, 0), b1);
	textureStore(out_b, texel + vec3i(0, 2 * SIZE.y, 0), b2);
}
