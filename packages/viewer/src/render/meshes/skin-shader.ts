/**
 * skeletal skinning compute shader: skins an animated geometry's bind pose at the current frame and writes
 * the result over its vertex streams in the quantized formats the mesh pipelines read.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { octDecode } from '../core/shader-math.ts';

/** sentinel value for a vertex stream the geometry lacks */
export const SKIN_NONE = 0xff_ff_ff_ff;

/** uniform parameters for one animated geometry's skinning dispatch */
export const SkinParamsSchema = d.struct({
	vertexCount: d.u32,
	boneCount: d.u32,
	frameA: d.u32,
	frameB: d.u32,
	/** how far from frame a to frame b */
	blend: d.f32,
	/** where the drawn normals and tangents start in `vertices`, in words; `SKIN_NONE` when absent */
	normalOut: d.u32,
	tangentOut: d.u32,
	/** where bind pose normals, tangents, weights and bones start in `source`, in words */
	normalIn: d.u32,
	tangentIn: d.u32,
	weightIn: d.u32,
	boneIn: d.u32,
	/** 1 when bones are `uint16x4` (two words per vertex), 0 for `uint8x4` */
	wideBones: d.u32,
	bindOffset: d.vec3f,
	bindScale: d.vec3f,
	/** drawn positions are quantized to `outOffset + [0, 1]^3 / outInvScale` */
	outOffset: d.vec3f,
	outInvScale: d.vec3f,
});

/** bind group layout for {@link csSkin} */
export const skinLayout = tgpu.bindGroupLayout({
	skin: { uniform: SkinParamsSchema },
	source: { storage: d.arrayOf(d.u32), access: 'readonly' },
	/** frame-major 3x4 matrices: three rows per bone */
	frames: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
	vertices: { storage: d.arrayOf(d.u32), access: 'mutable' },
});

/** `octEncode` guarded against the zero vector from unweighted vertices */
const octEncodeGuarded = tgpu.fn(
	[d.vec3f],
	d.vec2f,
)((v) => {
	'use gpu';
	const n = std.div(v, std.max(std.abs(v.x) + std.abs(v.y) + std.abs(v.z), 1e-20));
	if (n.z < 0) {
		return std.mul(
			std.sub(d.vec2f(1), std.abs(n.yx)),
			std.select(d.vec2f(-1), d.vec2f(1), std.ge(n.xy, d.vec2f(0))),
		);
	}
	return n.xy;
});

/** row `r` of a bone's matrix, blended between the two frames */
const boneRow = tgpu.fn(
	[d.u32, d.u32],
	d.vec4f,
)((bone, r) => {
	'use gpu';
	const skin = skinLayout.$.skin;
	const a = skinLayout.$.frames[(skin.frameA * skin.boneCount + bone) * 3 + r];
	const b = skinLayout.$.frames[(skin.frameB * skin.boneCount + bone) * 3 + r];
	return std.mix(a, b, skin.blend);
});

/** compute entrypoint skinning one vertex per invocation */
export const csSkin = tgpu.computeFn({
	workgroupSize: [64],
	in: { id: d.builtin.globalInvocationId },
})((input) => {
	'use gpu';
	const skin = skinLayout.$.skin;
	const v = input.id.x;
	if (v >= skin.vertexCount) {
		return;
	}
	const source = skinLayout.$.source;
	const xy = std.unpack2x16unorm(source[v * 2]);
	const z = std.unpack2x16unorm(source[v * 2 + 1]).x;
	const position = d.vec4f(std.add(skin.bindOffset, std.mul(d.vec3f(xy, z), skin.bindScale)), 1);
	const weights = d.vec4f(
		std.unpack2x16unorm(source[skin.weightIn + v * 2]),
		std.unpack2x16unorm(source[skin.weightIn + v * 2 + 1]),
	);
	const bones = d.arrayOf(d.u32, 4)();
	if (skin.wideBones !== 0) {
		const low = source[skin.boneIn + v * 2];
		const high = source[skin.boneIn + v * 2 + 1];
		bones[0] = low & 0xffff;
		bones[1] = low >>> 16;
		bones[2] = high & 0xffff;
		bones[3] = high >>> 16;
	} else {
		const packed = source[skin.boneIn + v];
		bones[0] = packed & 0xff;
		bones[1] = (packed >>> 8) & 0xff;
		bones[2] = (packed >>> 16) & 0xff;
		bones[3] = packed >>> 24;
	}
	let r0 = d.vec4f(0);
	let r1 = d.vec4f(0);
	let r2 = d.vec4f(0);
	for (let k = d.u32(0); k < 4; k++) {
		const w = weights[k];
		if (w === 0) {
			continue;
		}
		const bone = bones[k];
		r0 = std.add(r0, std.mul(w, boneRow(bone, 0)));
		r1 = std.add(r1, std.mul(w, boneRow(bone, 1)));
		r2 = std.add(r2, std.mul(w, boneRow(bone, 2)));
	}
	const moved = d.vec3f(std.dot(r0, position), std.dot(r1, position), std.dot(r2, position));
	const q = std.clamp(std.mul(std.sub(moved, skin.outOffset), skin.outInvScale), d.vec3f(0), d.vec3f(1));
	skinLayout.$.vertices[v * 2] = std.pack2x16unorm(q.xy);
	skinLayout.$.vertices[v * 2 + 1] = std.pack2x16unorm(d.vec2f(q.z, 0));
	// directions turn by the matrix's linear part, as Unity's skinning turns them
	const linear = d.mat3x3f(r0.xyz, r1.xyz, r2.xyz);
	if (skin.normalOut !== SKIN_NONE) {
		const normal = octDecode(std.unpack2x16snorm(source[skin.normalIn + v]));
		skinLayout.$.vertices[skin.normalOut + v] = std.pack2x16snorm(octEncodeGuarded(std.mul(normal, linear)));
	}
	if (skin.tangentOut !== SKIN_NONE) {
		const tangent = std.unpack4x8snorm(source[skin.tangentIn + v]);
		const turned = octEncodeGuarded(std.mul(octDecode(tangent.xy), linear));
		skinLayout.$.vertices[skin.tangentOut + v] = std.pack4x8snorm(d.vec4f(turned, tangent.z, 0));
	}
});
