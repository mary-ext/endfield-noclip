/**
 * irradiance clipmap update compute shader: fills one toroidal level from resident cell blobs and room region
 * bakes, falling back to the next coarser level where a probe is absent.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { irradianceZ, irradianceZClamped } from './irradiance-clipmap.ts';

/** uniform parameters for one clipmap level update */
export const IrradianceUpdateSchema = d.struct({
	/** xyz: probe index (in this level's spacing) of the clipmap's centre, w: level */
	center: d.vec4i,
	/** xyz: cell index (p >> (6 + level)) of the window's minimum corner, w: first word in `windows` */
	window: d.vec4i,
	/** xyz: window size in cells, w: how many of `regions` apply */
	windowSize: d.vec4i,
});

/** a room's dense probe bake on the finest level's lattice */
export const IrradianceRegionSchema = d.struct({
	/** xyz: first probe's index (0.5 m units, world 0 at 0), w: first word in `cells` */
	origin: d.vec4i,
	/** xyz: probes per axis, x fastest in `cells` */
	size: d.vec4i,
});

/** bind group layout for {@link csIrradianceUpdate} */
export const irradianceUpdateLayout = tgpu.bindGroupLayout({
	update: { uniform: IrradianceUpdateSchema },
	cells: { storage: d.arrayOf(d.u32), access: 'readonly' },
	windows: { storage: d.arrayOf(d.u32), access: 'readonly' },
	outA: { storageTexture: d.textureStorage3d('rgba16float', 'write-only') },
	outB: { storageTexture: d.textureStorage3d('rgba8unorm', 'write-only') },
	coarseA: { texture: d.texture3d(d.f32) },
	coarseB: { texture: d.texture3d(d.f32) },
	coarseRepeat: { sampler: 'filtering' },
	coarseClamp: { sampler: 'filtering' },
	regions: { storage: d.arrayOf(IrradianceRegionSchema), access: 'readonly' },
});

const SIZE = tgpu.const(d.vec3i, d.vec3i(128, 64, 128));
const COARSEST = 2;
const ORIGIN = 8192;

const modulo = tgpu.fn(
	[d.vec3i, d.vec3i],
	d.vec3i,
)((a, n) => {
	'use gpu';
	return std.mod(std.add(std.mod(a, n), n), n);
});

const findProbe = tgpu.fn(
	[d.u32, d.vec3i, d.i32],
	d.i32,
)((cell, p, level) => {
	'use gpu';
	const cells = irradianceUpdateLayout.$.cells;
	const t = d.i32(cells[cell]);
	const o = d.i32(cells[cell + 1]);
	const mask = (64 << d.u32(level)) - 1;
	const blockShift = d.u32(2 + 2 * level);
	const block = d.vec3i((p.x & mask) >> blockShift, (p.y & mask) >> blockShift, (p.z & mask) >> blockShift);
	const subShift = d.u32(2 * level);
	const sub = d.vec3i((p.x >> subShift) & 3, (p.y >> subShift) & 3, (p.z >> subShift) & 3);
	const bit = d.u32(
		(((sub.x << 2) | sub.x) & 9) |
			(((sub.y << 3) | (sub.y << 1)) & 18) |
			(((sub.z << 4) | (sub.z << 2)) & 36),
	);
	const oi = std.mod(block, d.vec3i(o));
	const offset = cells[cell + 2 + d.u32(oi.x + oi.y * o + oi.z * o * o)];
	const h = std.mod(
		std.add(block, d.vec3i(d.i32(offset & 255), d.i32((offset >>> 8) & 255), d.i32((offset >>> 16) & 255))),
		d.vec3i(t),
	);
	const entry = cell + 2 + d.u32(o * o * o) + d.u32(h.x + h.y * t + h.z * t * t) * 4;
	if (cells[entry] !== d.u32(block.x | (block.y << 8) | (block.z << 16))) {
		return -1;
	}
	const lo = cells[entry + 2];
	const hi = cells[entry + 3];
	let below = d.u32(0);
	if (bit < 32) {
		if (((lo >>> bit) & 1) === 0) {
			return -1;
		}
		below = std.countOneBits(lo & ((d.u32(1) << bit) - 1));
	} else {
		const hiBit = bit - 32;
		if (((hi >>> hiBit) & 1) === 0) {
			return -1;
		}
		below = std.countOneBits(lo) + std.countOneBits(hi & ((d.u32(1) << hiBit) - 1));
	}
	return d.i32(cell + (cells[entry + 1] >>> 2) + below * 4);
});

/** compute entrypoint filling one irradiance clipmap level into scratch A and B 3D textures */
export const csIrradianceUpdate = tgpu.computeFn({
	workgroupSize: [4, 4, 4],
	in: { id: d.builtin.globalInvocationId },
})((input) => {
	'use gpu';
	const texel = d.vec3i(input.id);
	if (std.any(std.ge(texel, SIZE.$))) {
		return;
	}
	const update = irradianceUpdateLayout.$.update;
	const level = update.center.w;
	const halfSize = d.vec3i(64, 32, 64);
	const lowest = std.sub(update.center.xyz, halfSize);
	const index = std.add(lowest, modulo(std.sub(texel, lowest), SIZE.$));
	const p = std.add(std.mul(index, d.i32(1) << d.u32(2 * level)), d.vec3i(ORIGIN));

	let at = -1;
	for (let i = 0; i < update.windowSize.w; i++) {
		const region = irradianceUpdateLayout.$.regions[i];
		const local = std.sub(index, region.origin.xyz);
		if (std.all(std.ge(local, d.vec3i(0))) && std.all(std.lt(local, region.size.xyz))) {
			at =
				region.origin.w + 4 * (local.x + local.y * region.size.x + local.z * region.size.x * region.size.y);
			break;
		}
	}
	const cellShift = d.u32(6 + level);
	const w = std.sub(d.vec3i(p.x >> cellShift, p.y >> cellShift, p.z >> cellShift), update.window.xyz);
	const size = update.windowSize.xyz;
	if (
		at < 0 &&
		std.all(std.ge(p, d.vec3i(0))) &&
		std.all(std.ge(w, d.vec3i(0))) &&
		std.all(std.lt(w, size))
	) {
		const slot =
			irradianceUpdateLayout.$.windows[d.u32(update.window.w + w.x + w.y * size.x + w.z * size.x * size.y)];
		if (slot !== 0) {
			at = findProbe(slot - 1, p, level);
		}
	}

	let a = d.vec4f(0);
	let b0 = d.vec4f(0);
	let b1 = d.vec4f(0);
	let b2 = d.vec4f(0);
	if (at >= 0) {
		const cells = irradianceUpdateLayout.$.cells;
		const word = cells[at];
		a = d.vec4f(
			std.unpack2x16float((word << 4) & 0x7ff0).x,
			std.unpack2x16float((word >>> 7) & 0x7ff0).x,
			std.unpack2x16float((word >>> 17) & 0x7fe0).x,
			0,
		);
		b0 = std.unpack4x8unorm(cells[at + 1]);
		b1 = std.unpack4x8unorm(cells[at + 2]);
		b2 = std.unpack4x8unorm(cells[at + 3]);
	} else if (level < COARSEST) {
		const uvw = std.fract(std.div(std.add(std.mul(d.vec3f(index), 0.25), d.vec3f(0.5)), d.vec3f(SIZE.$)));
		const halfY = 0.5 / d.f32(SIZE.$.y);
		const v = std.clamp(uvw.y, halfY, 1 - halfY) / 3;
		const coarse = level + 1;
		a = std.textureSampleLevel(
			irradianceUpdateLayout.$.coarseA,
			irradianceUpdateLayout.$.coarseRepeat,
			d.vec3f(uvw.xy, irradianceZ(coarse, uvw.z)),
			0,
		);
		const z = irradianceZClamped(coarse, uvw.z);
		b0 = std.textureSampleLevel(
			irradianceUpdateLayout.$.coarseB,
			irradianceUpdateLayout.$.coarseClamp,
			d.vec3f(uvw.x, v, z),
			0,
		);
		b1 = std.textureSampleLevel(
			irradianceUpdateLayout.$.coarseB,
			irradianceUpdateLayout.$.coarseClamp,
			d.vec3f(uvw.x, v + 1 / 3, z),
			0,
		);
		b2 = std.textureSampleLevel(
			irradianceUpdateLayout.$.coarseB,
			irradianceUpdateLayout.$.coarseClamp,
			d.vec3f(uvw.x, v + 2 / 3, z),
			0,
		);
	} else {
		a = d.vec4f(0);
		b0 = d.vec4f(0, 0, 0, 1);
		b1 = d.vec4f(0);
		b2 = d.vec4f(0);
	}
	std.textureStore(irradianceUpdateLayout.$.outA, texel, a);
	std.textureStore(irradianceUpdateLayout.$.outB, texel, b0);
	std.textureStore(irradianceUpdateLayout.$.outB, std.add(texel, d.vec3i(0, SIZE.$.y, 0)), b1);
	std.textureStore(irradianceUpdateLayout.$.outB, std.add(texel, d.vec3i(0, 2 * SIZE.$.y, 0)), b2);
});
