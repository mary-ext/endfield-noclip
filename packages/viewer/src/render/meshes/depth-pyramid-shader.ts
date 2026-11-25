/**
 * depth pyramid compute shaders: builds a pyramid of the farthest (reversed-Z minimum) depth under each texel
 * from the main pass's depth buffer, taking in the extra edge row/column on odd-sized levels.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

/** bind group layout for the first level (reads `texture_depth_2d`) */
export const depthPyramidFirstLayout = tgpu.bindGroupLayout({
	sourceDepth: { texture: d.textureDepth2d() },
	output: { storageTexture: d.textureStorage2d('r32float', 'write-only') },
});

/** bind group layout for subsequent levels (reads `r32float` `texture_2d<f32>`) */
export const depthPyramidDownLayout = tgpu.bindGroupLayout({
	source: { texture: d.texture2d(d.f32) },
	output: { storageTexture: d.textureStorage2d('r32float', 'write-only') },
});

/** source texels under a target texel: its 2x2 footprint plus any odd-source edge row or column */
const footprint = tgpu.fn(
	[d.vec2u, d.vec2u, d.vec2u],
	d.vec4i,
)((id, targetSize, sourceSize) => {
	'use gpu';
	const first = d.vec2i(std.mul(id, 2));
	const lastX = id.x === targetSize.x - 1 && sourceSize.x > targetSize.x * 2;
	const lastY = id.y === targetSize.y - 1 && sourceSize.y > targetSize.y * 2;
	const count = d.vec2i(std.select(2, 3, lastX), std.select(2, 3, lastY));
	return d.vec4i(first, count);
});

/** compute entrypoint for mip 0 from the main pass's depth texture */
export const csDepthPyramidFirst = tgpu.computeFn({
	workgroupSize: [8, 8],
	in: { id: d.builtin.globalInvocationId },
})((input) => {
	'use gpu';
	const size = std.textureDimensions(depthPyramidFirstLayout.$.output);
	if (std.any(std.ge(input.id.xy, size))) {
		return;
	}
	const sourceSize = std.textureDimensions(depthPyramidFirstLayout.$.sourceDepth);
	const area = footprint(input.id.xy, size, sourceSize);
	const edge = std.sub(d.vec2i(sourceSize), d.vec2i(1));
	let depth = d.f32(1);
	for (let y = 0; y < area.w; y++) {
		for (let x = 0; x < area.z; x++) {
			depth = std.min(
				depth,
				std.textureLoad(
					depthPyramidFirstLayout.$.sourceDepth,
					std.min(std.add(area.xy, d.vec2i(x, y)), edge),
					0,
				),
			);
		}
	}
	std.textureStore(depthPyramidFirstLayout.$.output, input.id.xy, d.vec4f(depth));
});

/** compute entrypoint for mip > 0 from the previous pyramid mip */
export const csDepthPyramidDown = tgpu.computeFn({
	workgroupSize: [8, 8],
	in: { id: d.builtin.globalInvocationId },
})((input) => {
	'use gpu';
	const size = std.textureDimensions(depthPyramidDownLayout.$.output);
	if (std.any(std.ge(input.id.xy, size))) {
		return;
	}
	const sourceSize = std.textureDimensions(depthPyramidDownLayout.$.source);
	const area = footprint(input.id.xy, size, sourceSize);
	const edge = std.sub(d.vec2i(sourceSize), d.vec2i(1));
	let depth = d.f32(1);
	for (let y = 0; y < area.w; y++) {
		for (let x = 0; x < area.z; x++) {
			depth = std.min(
				depth,
				std.textureLoad(depthPyramidDownLayout.$.source, std.min(std.add(area.xy, d.vec2i(x, y)), edge), 0).r,
			);
		}
	}
	std.textureStore(depthPyramidDownLayout.$.output, input.id.xy, d.vec4f(depth));
});
