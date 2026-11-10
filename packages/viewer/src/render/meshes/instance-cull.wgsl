// GPU culling of the instance rows the mesh selection leaves to it (gpu-cull-work.ts): each row is tested as
// MeshSelector's #selectRows tests it (size, frustum or caster volume, LOD band, first shadow layer) and
// appended to its buckets' regions of the visible list, where the CPU made room for them. constants come
// from instance-culler.ts: ITEM_WORDS, SLOT_WORDS, BUCKET_WORDS, BUCKET_DRAW, COUNTER_WORDS, INDIRECT_WORDS, STATS_WORDS,
// SHADOW_LAYERS, BLOCK_SLOT_BITS, NO_BUCKET, ITEM_INSIDE, SLOT_CASTS, SLOT_SHADOW_ONLY, SLOT_REALTIME, SLOT_STATIC,
// MAX_GROUPS_X

struct View {
	planes: array<vec4f, 5>,
	caster_planes: array<vec4f, 5>,
	shadow_axes: array<vec4f, 3>,
	shadow_layers: array<vec4f, 4>,
	// camera-relative spheres (xyz, radius) whose rows cast into a local light's shadow map
	light_casters: array<vec4f, 8>,
	plane_count: u32,
	caster_plane_count: u32,
	item_count: u32,
	bucket_count: u32,
	pixel_factor: f32,
	viewport_height: f32,
	min_pixels: f32,
	caster_min_pixels: f32,
	caster_distance: f32,
	shadow_reach: f32,
	shadows: u32,
	slots_at: u32,
	buckets_at: u32,
	light_caster_count: u32,
	pad1: u32,
	pad2: u32,
	// last frame's camera-relative view-projection, whose depth the pyramid holds
	previous: mat4x4f,
	// this frame's eye minus last frame's
	eye_delta: vec3f,
	// 1 to test rows in view against the pyramid
	occlusion: u32,
	// the pyramid's first level, texels, and its levels
	pyramid_size: vec2f,
	pyramid_levels: u32,
	near: f32,
}

@group(0) @binding(0) var<uniform> view: View;
// instance rows as vec4s: the transform's three rows, the bounds centre and block word, the half extents
@group(0) @binding(1) var<storage, read> rows: array<vec4f>;
@group(0) @binding(2) var<storage, read> blocks: array<vec4f>;
// items, then slots from view.slots_at, then buckets from view.buckets_at
@group(0) @binding(3) var<storage, read> work: array<u32>;
// the stats, then COUNTER_WORDS per bucket
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> list: array<u32>;
@group(0) @binding(6) var<storage, read_write> draw_ids: array<u32>;
@group(0) @binding(7) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(8) var pyramid: texture_2d<f32>;

const ROW_VEC4S = 6u;

// a row as the selection sees it; `layer` is SHADOW_LAYERS when it casts into none
struct Tested {
	drawn: bool,
	in_view: bool,
	// in view, but behind what last frame drew: it only casts
	occluded: bool,
	squared: f32,
	mirrored: u32,
	layer: u32,
}

fn first_layer(p: vec3f, radius: f32) -> u32 {
	if (view.shadows == 0u) {
		return SHADOW_LAYERS;
	}
	let u = dot(p, view.shadow_axes[0].xyz);
	let v = dot(p, view.shadow_axes[1].xyz);
	let w = dot(p, view.shadow_axes[2].xyz);
	for (var layer = 0u; layer < SHADOW_LAYERS; layer++) {
		let s = view.shadow_layers[layer];
		let reach = s.w + radius;
		let dw = w - s.z;
		if (abs(u - s.x) <= reach && abs(v - s.y) <= reach && dw <= reach && dw >= -reach - view.shadow_reach) {
			return layer;
		}
	}
	return SHADOW_LAYERS;
}

fn in_planes(p: vec3f, radius: f32) -> bool {
	for (var i = 0u; i < view.plane_count; i++) {
		let plane = view.planes[i];
		if (dot(plane.xyz, p) + plane.w < -radius) {
			return false;
		}
	}
	return true;
}

fn in_caster_planes(p: vec3f, radius: f32) -> bool {
	for (var i = 0u; i < view.caster_plane_count; i++) {
		let plane = view.caster_planes[i];
		if (dot(plane.xyz, p) + plane.w < -radius) {
			return false;
		}
	}
	return true;
}

fn in_light_casters(p: vec3f, radius: f32) -> bool {
	for (var i = 0u; i < view.light_caster_count; i++) {
		let sphere = view.light_casters[i];
		let d = p - sphere.xyz;
		let reach = radius + sphere.w;
		if (dot(d, d) <= reach * reach) {
			return true;
		}
	}
	return false;
}

// whether a sphere was wholly behind last frame's depth, as seen from last frame's camera. bounds that reach off
// that screen or in front of its near plane count as visible
fn occluded(p: vec3f, radius: f32) -> bool {
	let centre = p + view.eye_delta;
	var low = vec2f(1.0);
	var high = vec2f(-1.0);
	var nearest = 0.0;
	for (var i = 0u; i < 8u; i++) {
		let corner = centre + radius * vec3f(
			select(-1.0, 1.0, (i & 1u) != 0u),
			select(-1.0, 1.0, (i & 2u) != 0u),
			select(-1.0, 1.0, (i & 4u) != 0u),
		);
		let clip = view.previous * vec4f(corner, 1.0);
		if (clip.w < view.near) {
			return false;
		}
		let ndc = clip.xyz / clip.w;
		low = min(low, ndc.xy);
		high = max(high, ndc.xy);
		nearest = max(nearest, ndc.z);
	}
	if (any(low < vec2f(-1.0)) || any(high > vec2f(1.0))) {
		return false;
	}
	// the first level's texels it covers (v down), a texel wider each way for the main pass's jitter
	let size = view.pyramid_size;
	let first = vec2i(floor((vec2f(low.x, -high.y) * 0.5 + 0.5) * size)) - 1;
	let last = vec2i(floor((vec2f(high.x, -low.y) * 0.5 + 0.5) * size)) + 1;
	let span = max(last.x - first.x, last.y - first.y);
	// the level where it spans at most three texels each way
	let level = u32(ceil(log2(f32(max(span, 1)))));
	if (level >= view.pyramid_levels) {
		return false;
	}
	let edge = vec2i(textureDimensions(pyramid, level)) - 1;
	let start = clamp(first >> vec2u(level), vec2i(0), edge);
	let stop = clamp(last >> vec2u(level), vec2i(0), edge);
	var farthest = 1.0;
	for (var y = start.y; y <= stop.y; y++) {
		for (var x = start.x; x <= stop.x; x++) {
			farthest = min(farthest, textureLoad(pyramid, vec2i(x, y), i32(level)).r);
		}
	}
	return nearest < farthest;
}

fn test_row(row: u32, flags: u32) -> Tested {
	var out: Tested;
	out.drawn = false;
	let at = row * ROW_VEC4S;
	let centre = rows[at + 3u];
	let extent = rows[at + 4u].xyz;
	let block = bitcast<u32>(centre.w) & ((1u << BLOCK_SLOT_BITS) - 1u);
	let p = blocks[block].xyz + centre.xyz;
	let radius = length(extent);
	let distance = max(length(p), 0.1);
	let pixels = radius * view.pixel_factor / distance;
	if (pixels < view.min_pixels) {
		return out;
	}
	out.in_view = (flags & ITEM_INSIDE) != 0u || in_planes(p, radius);
	if (!out.in_view) {
		if (pixels < view.caster_min_pixels) {
			return out;
		}
		let sun_caster = view.caster_plane_count != 0u && distance - radius <= view.caster_distance &&
			in_caster_planes(p, radius);
		if (!sun_caster && !in_light_casters(p, radius)) {
			return out;
		}
	}
	// Unity's LODGroup metric: the object's size relative to the screen height
	let size = max(extent.x, max(extent.y, extent.z));
	let relative = 2.0 * size * view.pixel_factor / (distance * view.viewport_height);
	out.squared = relative * relative;
	let basis = mat3x3f(rows[at].xyz, rows[at + 1u].xyz, rows[at + 2u].xyz);
	out.mirrored = select(0u, 1u, determinant(basis) < 0.0);
	out.layer = first_layer(p, radius);
	out.occluded = out.in_view && view.occlusion != 0u && occluded(p, radius);
	out.drawn = true;
	return out;
}

// the item a workgroup runs, MAX_GROUPS_X workgroups to a row of the dispatch
fn item_of(group: vec3u) -> u32 {
	return group.x + group.y * MAX_GROUPS_X;
}

// appends a row to one of a bucket's regions (`region` 0 for its rows in view, 1 + layer for a shadow
// layer's casters), if it has room
fn append(bucket: u32, region: u32, row: u32) {
	let b = view.buckets_at + bucket * BUCKET_WORDS;
	let i = atomicAdd(&counters[STATS_WORDS + bucket * COUNTER_WORDS + region], 1u);
	if (i < work[b + region * 2u + 1u]) {
		let at = work[b + region * 2u] + i;
		list[at] = row;
		draw_ids[at] = work[b + BUCKET_DRAW];
	}
}

// tests a row and appends it to each of its slots' buckets: to the rows in view, and to the casters of every
// layer from its first on that the slot casts into (the sharp cascades take realtime casters, the far layer
// static ones)
@compute @workgroup_size(32)
fn cs_write(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
	let item = item_of(group);
	if (item >= view.item_count) {
		return;
	}
	let at = item * ITEM_WORDS;
	let packed = work[at + 1u];
	if (lane >= (packed & 255u)) {
		return;
	}
	let row = work[at] + lane;
	let tested = test_row(row, packed);
	if (!tested.drawn) {
		return;
	}
	let slots = view.slots_at + work[at + 2u] * SLOT_WORDS;
	for (var s = 0u; s < work[at + 3u]; s++) {
		let slot = slots + s * SLOT_WORDS;
		if (!(tested.squared > bitcast<f32>(work[slot]) && tested.squared <= bitcast<f32>(work[slot + 1u]))) {
			continue;
		}
		let flags = work[slot + 2u];
		let casts = (flags & SLOT_CASTS) != 0u;
		if (!tested.in_view && !casts) {
			continue;
		}
		let bucket = work[slot + 3u + tested.mirrored];
		if (bucket == NO_BUCKET) {
			continue;
		}
		if (tested.in_view && !tested.occluded && (flags & SLOT_SHADOW_ONLY) == 0u) {
			append(bucket, 0u, row);
		}
		if (casts) {
			for (var layer = tested.layer; layer < SHADOW_LAYERS; layer++) {
				let takes = select(SLOT_REALTIME, SLOT_STATIC, layer == SHADOW_LAYERS - 1u);
				if ((flags & takes) != 0u) {
					append(bucket, 1u + layer, row);
				}
			}
		}
	}
}

// writes each bucket's indirect arguments from its counts, clamped to the room it has, and sums the stats
@compute @workgroup_size(64)
fn cs_arguments(@builtin(global_invocation_id) id: vec3u) {
	let bucket = id.x;
	if (bucket >= view.bucket_count) {
		return;
	}
	let b = view.buckets_at + bucket * BUCKET_WORDS;
	let c = STATS_WORDS + bucket * COUNTER_WORDS;
	let index_count = work[b + BUCKET_DRAW + 1u];
	let first_index = work[b + BUCKET_DRAW + 2u];
	let base_vertex = work[b + BUCKET_DRAW + 3u];
	for (var region = 0u; region <= SHADOW_LAYERS; region++) {
		let count = min(atomicLoad(&counters[c + region]), work[b + region * 2u + 1u]);
		let out = bucket * INDIRECT_WORDS + region * 5u;
		indirect[out] = index_count;
		indirect[out + 1u] = count;
		indirect[out + 2u] = first_index;
		indirect[out + 3u] = base_vertex;
		indirect[out + 4u] = work[b + region * 2u];
		if (region == 0u && count > 0u) {
			atomicAdd(&counters[0], count);
			atomicAdd(&counters[1], count * (index_count / 3u));
		}
	}
}
