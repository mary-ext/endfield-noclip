import { createHash } from 'node:crypto';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { ktx2FormatInfo } from '@endfield-noclip/formats/binary/ktx2';
import type { DecodedTexture, UnitySamplerSettings } from '@endfield-noclip/formats/unity/texture';
import {
	type ReadyTexture,
	TEXTURE_TAIL_BYTES,
	textureLevelByteLength,
	type TextureSampler,
} from '@endfield-noclip/package-format/textures';

// turns a decoded Unity texture into the package's form: the game's texel blocks untouched, split into a mip
// tail piece plus one piece per larger level, with format and sampler in WebGPU terms.

/** a texture's levels grouped into blobs, before storage */
export interface TexturePieceData {
	firstLevel: number;
	levelCount: number;
	data: Uint8Array;
}

/** a texture converted for the package */
export interface ConvertedTexture {
	/** the entry's fields except its pieces */
	entry: Omit<ReadyTexture, 'id' | 'status' | 'pieces'>;
	/** coarse to fine: the mip tail first, then one piece per larger level */
	pieces: TexturePieceData[];
	/** equal for textures with the same shape, format, sampler and texels */
	contentKey: string;
}

/**
 * @param texture a decoded texture
 * @returns its package form
 * @throws {FormatError} if WebGPU has no equivalent format or the level sizes don't match the layout
 */
export const convertTexture = (texture: DecodedTexture): ConvertedTexture => {
	const format = ktx2FormatInfo(texture.vkFormat)?.gpuFormat;
	if (format === undefined) {
		throw new FormatError(`texture ${texture.name}: ${texture.format.name} has no WebGPU format`);
	}
	const entry: ConvertedTexture['entry'] = {
		kind: texture.kind,
		format,
		width: texture.width,
		height: texture.height,
		depthOrArrayLayers: texture.kind === '3d' ? texture.depth : texture.layers * texture.faces,
		mipCount: texture.levels.length,
		sampler: gpuSampler(texture.sampler),
	};
	for (const [level, data] of texture.levels.entries()) {
		const expected = textureLevelByteLength(entry, level);
		if (data.byteLength !== expected) {
			throw new FormatError(
				`texture ${texture.name} level ${level} is ${data.byteLength} bytes, its layout needs ${expected}`,
			);
		}
	}
	const pieces = splitLevels(texture.levels);
	const hash = createHash('sha256').update(JSON.stringify(entry));
	for (const level of texture.levels) {
		hash.update(level);
	}
	return { entry, pieces, contentKey: hash.digest('hex') };
};

/**
 * groups mip levels into pieces: the longest run of smallest levels within {@link TEXTURE_TAIL_BYTES} (at
 * least the last level) as one piece, then each larger level alone
 *
 * @param levels level data, largest first
 * @returns the pieces, coarse to fine
 */
export const splitLevels = (levels: readonly Uint8Array[]): TexturePieceData[] => {
	let tail = levels.length - 1;
	let tailBytes = levels[tail]?.byteLength ?? 0;
	while (tail > 0 && tailBytes + levels[tail - 1].byteLength <= TEXTURE_TAIL_BYTES) {
		tail--;
		tailBytes += levels[tail].byteLength;
	}
	if (tail < 0) {
		return [];
	}
	const data = new Uint8Array(tailBytes);
	let at = 0;
	for (let level = tail; level < levels.length; level++) {
		data.set(levels[level], at);
		at += levels[level].byteLength;
	}
	const pieces: TexturePieceData[] = [{ firstLevel: tail, levelCount: levels.length - tail, data }];
	for (let level = tail - 1; level >= 0; level--) {
		pieces.push({ firstLevel: level, levelCount: 1, data: levels[level] });
	}
	return pieces;
};

const ADDRESS_MODES: TextureSampler['addressModeU'][] = [
	'repeat',
	'clamp-to-edge',
	'mirror-repeat',
	// Unity's mirror-once has no WebGPU counterpart
	'mirror-repeat',
];

const address = (mode: number): TextureSampler['addressModeU'] => ADDRESS_MODES[mode] ?? 'repeat';

const gpuSampler = (sampler: UnitySamplerSettings): TextureSampler => {
	const linear = sampler.filterMode >= 1;
	const trilinear = sampler.filterMode >= 2;
	return {
		addressModeU: address(sampler.wrapU),
		addressModeV: address(sampler.wrapV),
		addressModeW: address(sampler.wrapW),
		magFilter: linear ? 'linear' : 'nearest',
		minFilter: linear ? 'linear' : 'nearest',
		mipmapFilter: trilinear ? 'linear' : 'nearest',
		maxAnisotropy: trilinear ? Math.min(16, Math.max(1, sampler.aniso)) : 1,
		mipBias: sampler.mipBias,
	};
};
