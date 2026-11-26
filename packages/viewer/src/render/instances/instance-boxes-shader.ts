/**
 * instance stand-in box shaders: draws each instance row's world AABB as a filled box or wireframe outline,
 * coloured by its kind (HLOD tier, detail, or global).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	GBufferOut,
	InstanceRow,
	defaultSurface,
	frameLayout,
	listRow,
	packGbuffer,
	packGbufferUnlit,
	rowBlock,
} from '../core/frame-core.ts';

/** group 1 bind group layout matching `BindLayouts.instances` (bindings 0..2 used by stand-in boxes) */
export const instanceBoxesLayout = tgpu
	.bindGroupLayout({
		rows: { storage: d.arrayOf(InstanceRow), access: 'readonly' },
		blocks: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
		list: { storage: d.arrayOf(d.u32), access: 'readonly' },
	})
	.$idx(1);

const BoxVertexOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	normal: d.interpolate('flat', d.vec3f),
	color: d.interpolate('flat', d.vec3f),
};

const BoxVertexStruct = d.struct({
	position: d.vec4f,
	rel: d.vec3f,
	normal: d.vec3f,
	color: d.vec3f,
});

const FACE_CORNERS = tgpu.const(d.arrayOf(d.vec2f, 6), [
	d.vec2f(-1, -1),
	d.vec2f(1, -1),
	d.vec2f(1, 1),
	d.vec2f(-1, -1),
	d.vec2f(1, 1),
	d.vec2f(-1, 1),
]);

const EDGES = tgpu.const(d.arrayOf(d.vec3f, 24), [
	d.vec3f(-1, -1, -1),
	d.vec3f(1, -1, -1),
	d.vec3f(-1, 1, -1),
	d.vec3f(1, 1, -1),
	d.vec3f(-1, -1, 1),
	d.vec3f(1, -1, 1),
	d.vec3f(-1, 1, 1),
	d.vec3f(1, 1, 1),
	d.vec3f(-1, -1, -1),
	d.vec3f(-1, 1, -1),
	d.vec3f(1, -1, -1),
	d.vec3f(1, 1, -1),
	d.vec3f(-1, -1, 1),
	d.vec3f(-1, 1, 1),
	d.vec3f(1, -1, 1),
	d.vec3f(1, 1, 1),
	d.vec3f(-1, -1, -1),
	d.vec3f(-1, -1, 1),
	d.vec3f(1, -1, -1),
	d.vec3f(1, -1, 1),
	d.vec3f(-1, 1, -1),
	d.vec3f(-1, 1, 1),
	d.vec3f(1, 1, -1),
	d.vec3f(1, 1, 1),
]);

const kindColor = tgpu.fn(
	[d.u32],
	d.vec3f,
)((kind) => {
	'use gpu';
	if (kind === d.u32(0)) {
		return d.vec3f(0.3, 0.62, 0.3);
	}
	if (kind === d.u32(1)) {
		return d.vec3f(0.8, 0.55, 0.18);
	}
	if (kind === d.u32(2)) {
		return d.vec3f(0.75, 0.25, 0.22);
	}
	if (kind === d.u32(3)) {
		return d.vec3f(0.62, 0.62, 0.66);
	}
	return d.vec3f(0.3, 0.45, 0.75);
});

const culled = tgpu.fn(
	[],
	BoxVertexStruct,
)(() => {
	'use gpu';
	return BoxVertexStruct({
		position: d.vec4f(2, 2, 2, 1),
		rel: d.vec3f(0),
		normal: d.vec3f(0),
		color: d.vec3f(0),
	});
});

const Box = d.struct({
	center: d.vec3f,
	extent: d.vec3f,
	color: d.vec3f,
	visible: d.bool,
	outlineOnly: d.bool,
});

const loadBox = tgpu.fn(
	[d.u32],
	Box,
)((index) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const row = instanceBoxesLayout.$.rows[index];
	const center = std.add(instanceBoxesLayout.$.blocks[rowBlock(row.block)].xyz, row.center);
	const extent = std.max(row.extent, d.vec3f(0.05));
	const color = kindColor(row.info & d.u32(7));
	const pixels = (std.length(extent) * frame.viewport.z) / std.max(std.length(center), 1);
	return Box({
		center,
		extent,
		color,
		visible: pixels >= frame.viewport.w,
		outlineOnly: std.max(extent.x, std.max(extent.y, extent.z)) > frame.params.x,
	});
});

const fillBox = tgpu.fn(
	[d.u32, d.u32],
	BoxVertexStruct,
)((vi, rowIndex) => {
	'use gpu';
	const box = loadBox(rowIndex);
	if (!box.visible || box.outlineOnly) {
		return culled();
	}
	const face = std.intdiv(vi, d.u32(6));
	const axis = face % d.u32(3);
	const sign = std.select(d.f32(-1), d.f32(1), face < d.u32(3));
	const c = FACE_CORNERS.$[vi % d.u32(6)];
	let corner = d.vec3f(c.x, c.y, sign);
	let normal = d.vec3f(0, 0, sign);
	if (axis === d.u32(0)) {
		corner = d.vec3f(sign, c.x, c.y);
		normal = d.vec3f(sign, 0, 0);
	} else if (axis === d.u32(1)) {
		corner = d.vec3f(c.x, sign, c.y);
		normal = d.vec3f(0, sign, 0);
	}
	const rel = std.add(box.center, std.mul(corner, box.extent));
	return BoxVertexStruct({
		position: std.mul(frameLayout.$.frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal,
		color: d.vec3f(box.color),
	});
});

const wireBox = tgpu.fn(
	[d.u32, d.u32],
	BoxVertexStruct,
)((vi, rowIndex) => {
	'use gpu';
	const box = loadBox(rowIndex);
	if (!box.visible || (frameLayout.$.frame.flags.x === d.u32(0) && !box.outlineOnly)) {
		return culled();
	}
	const rel = std.add(box.center, std.mul(EDGES.$[vi], box.extent));
	return BoxVertexStruct({
		position: std.mul(frameLayout.$.frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal: d.vec3f(0, 1, 0),
		color: d.vec3f(box.color),
	});
});

/** vertex entrypoint for filled boxes indexed directly by `instance_index` */
export const vsBoxFill = tgpu.vertexFn({
	in: { vi: d.builtin.vertexIndex, ii: d.builtin.instanceIndex },
	out: BoxVertexOut,
})((input) => {
	'use gpu';
	const out = fillBox(input.vi, input.ii);
	return {
		position: d.vec4f(out.position),
		rel: d.vec3f(out.rel),
		normal: d.vec3f(out.normal),
		color: d.vec3f(out.color),
	};
});

/** vertex entrypoint for filled boxes indexed through the visible-instance list */
export const vsBoxFillList = tgpu.vertexFn({
	in: { vi: d.builtin.vertexIndex, ii: d.builtin.instanceIndex },
	out: BoxVertexOut,
})((input) => {
	'use gpu';
	const out = fillBox(input.vi, listRow(instanceBoxesLayout.$.list[input.ii]));
	return {
		position: d.vec4f(out.position),
		rel: d.vec3f(out.rel),
		normal: d.vec3f(out.normal),
		color: d.vec3f(out.color),
	};
});

/** vertex entrypoint for wireframe boxes indexed directly by `instance_index` */
export const vsBoxWire = tgpu.vertexFn({
	in: { vi: d.builtin.vertexIndex, ii: d.builtin.instanceIndex },
	out: BoxVertexOut,
})((input) => {
	'use gpu';
	const out = wireBox(input.vi, input.ii);
	return {
		position: d.vec4f(out.position),
		rel: d.vec3f(out.rel),
		normal: d.vec3f(out.normal),
		color: d.vec3f(out.color),
	};
});

/** vertex entrypoint for wireframe boxes indexed through the visible-instance list */
export const vsBoxWireList = tgpu.vertexFn({
	in: { vi: d.builtin.vertexIndex, ii: d.builtin.instanceIndex },
	out: BoxVertexOut,
})((input) => {
	'use gpu';
	const out = wireBox(input.vi, listRow(instanceBoxesLayout.$.list[input.ii]));
	return {
		position: d.vec4f(out.position),
		rel: d.vec3f(out.rel),
		normal: d.vec3f(out.normal),
		color: d.vec3f(out.color),
	};
});

/** fragment entrypoint packing a filled stand-in box into the G-buffer */
export const fsBoxFill = tgpu.fragmentFn({
	in: BoxVertexOut,
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	const out = packGbuffer(defaultSurface(input.color, input.normal), false, d.u32(0));
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(out.velocity),
	};
});

/** fragment entrypoint packing a wireframe box edge as unlit into the G-buffer */
export const fsBoxWire = tgpu.fragmentFn({
	in: BoxVertexOut,
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	const out = packGbufferUnlit(std.mul(input.color, 1.4), d.u32(0));
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(out.velocity),
	};
});
