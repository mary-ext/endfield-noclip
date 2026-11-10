// skins an animated geometry's bind pose at the current frame and writes the result over its own vertex
// streams, in the formats the mesh pipelines read (`DecodedSkin` in decode-protocol.ts, `SkinAnimation` in
// package-format). needs octahedral.wgsl

struct Skin {
	vertex_count: u32,
	bone_count: u32,
	frame_a: u32,
	frame_b: u32,
	/** how far from frame a to frame b */
	blend: f32,
	/** where the drawn normals and tangents start in `vertices`, in words; NONE where the mesh lacks them */
	normal_out: u32,
	tangent_out: u32,
	/** where the bind pose's normals and tangents, the weights and the bones start in `source`, in words */
	normal_in: u32,
	tangent_in: u32,
	weight_in: u32,
	bone_in: u32,
	_pad0: u32,
	bind_offset: vec3f,
	bind_scale: vec3f,
	/** the drawn positions are quantized to `out_offset + [0, 1]³ / out_inv_scale` */
	out_offset: vec3f,
	out_inv_scale: vec3f,
}

const NONE = 0xffffffffu;

@group(0) @binding(0) var<uniform> skin: Skin;
@group(0) @binding(1) var<storage, read> source: array<u32>;
/** frame-major rows3x4 matrices: three rows per bone */
@group(0) @binding(2) var<storage, read> frames: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> vertices: array<u32>;

// `oct_encode` (octahedral.wgsl), safe for the zero vector a vertex without weights turns its directions into
fn oct_encode_guarded(v: vec3f) -> vec2f {
	let n = v / max(abs(v.x) + abs(v.y) + abs(v.z), 1e-20);
	if (n.z < 0.0) {
		return (1.0 - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
	}
	return n.xy;
}

/** row `r` of a bone's matrix, blended between the two frames */
fn bone_row(bone: u32, r: u32) -> vec4f {
	let a = frames[(skin.frame_a * skin.bone_count + bone) * 3u + r];
	let b = frames[(skin.frame_b * skin.bone_count + bone) * 3u + r];
	return mix(a, b, skin.blend);
}

@compute @workgroup_size(64)
fn cs_skin(@builtin(global_invocation_id) id: vec3u) {
	let v = id.x;
	if (v >= skin.vertex_count) {
		return;
	}
	let xy = unpack2x16unorm(source[v * 2u]);
	let z = unpack2x16unorm(source[v * 2u + 1u]).x;
	let position = vec4f(skin.bind_offset + vec3f(xy, z) * skin.bind_scale, 1.0);
	let weights = vec4f(
		unpack2x16unorm(source[skin.weight_in + v * 2u]),
		unpack2x16unorm(source[skin.weight_in + v * 2u + 1u]),
	);
	let bones = source[skin.bone_in + v];
	var r0 = vec4f(0.0);
	var r1 = vec4f(0.0);
	var r2 = vec4f(0.0);
	for (var k = 0u; k < 4u; k++) {
		let w = weights[k];
		if (w == 0.0) {
			continue;
		}
		let bone = (bones >> (k * 8u)) & 0xffu;
		r0 += w * bone_row(bone, 0u);
		r1 += w * bone_row(bone, 1u);
		r2 += w * bone_row(bone, 2u);
	}
	let moved = vec3f(dot(r0, position), dot(r1, position), dot(r2, position));
	let q = clamp((moved - skin.out_offset) * skin.out_inv_scale, vec3f(0.0), vec3f(1.0));
	vertices[v * 2u] = pack2x16unorm(q.xy);
	vertices[v * 2u + 1u] = pack2x16unorm(vec2f(q.z, 0.0));
	// directions turn by the matrix's linear part, as Unity's skinning turns them
	let linear = mat3x3f(r0.xyz, r1.xyz, r2.xyz);
	if (skin.normal_out != NONE) {
		let normal = oct_decode(unpack2x16snorm(source[skin.normal_in + v]));
		vertices[skin.normal_out + v] = pack2x16snorm(oct_encode_guarded(normal * linear));
	}
	if (skin.tangent_out != NONE) {
		let tangent = unpack4x8snorm(source[skin.tangent_in + v]);
		let turned = oct_encode_guarded(oct_decode(tangent.xy) * linear);
		vertices[skin.tangent_out + v] = pack4x8snorm(vec4f(turned, tangent.z, 0.0));
	}
}
