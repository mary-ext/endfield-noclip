import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	type MaterialRecord,
	parseMaterial,
	type ShaderSummary,
} from '@endfield-noclip/formats/unity/material';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import { errorText } from '../../errors.ts';
import { loadShaderSummary } from '../assets/asset-decode.ts';
import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

import { classifyHgrpMaterial, type MaterialClassification } from './material-classify.ts';

// materials are loaded here rather than in asset-decode.ts, so the conversion worker, which imports that
// module, doesn't import their classification: changing it then keeps the mesh and texture cache

/** a material's texture slot with its texture located */
export interface ResolvedTextureSlot {
	/** the texture object, or `null` for empty slots */
	ref: ObjectRef | null;
	/** set when the PPtr couldn't be followed */
	error?: string;
}

/** a material with its shader and textures located */
export interface LoadedMaterial {
	record: MaterialRecord;
	shader: ShaderSummary;
	classification: MaterialClassification;
	textures: Record<string, ResolvedTextureSlot>;
}

/**
 * @param resolver asset resolver
 * @param ref a Material object
 * @returns the material, its shader summary, classification and located textures
 * @throws {Error} if the material or its shader can't be read
 */
export const loadMaterial = async (resolver: AssetResolver, ref: ObjectRef): Promise<LoadedMaterial> => {
	if (ref.info.classId !== UnityClass.Material) {
		throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a Material`);
	}
	const record = parseMaterial(await resolver.read(ref));
	const shaderRef = await resolver.resolve(ref, record.shader);
	if (shaderRef === null) {
		throw new FormatError(`material ${record.name} has no shader`);
	}
	const shader = await loadShaderSummary(resolver, shaderRef);
	// in the material's slot order, whichever resolves first: texture ids follow it
	const textures = Object.fromEntries(
		await Promise.all(
			Object.entries(record.textures).map(
				async ([slot, { texture }]): Promise<[string, ResolvedTextureSlot]> => {
					if (texture === null) {
						return [slot, { ref: null }];
					}
					try {
						return [slot, { ref: await resolver.resolve(ref, texture) }];
					} catch (error) {
						return [slot, { ref: null, error: errorText(error) }];
					}
				},
			),
		),
	);
	return { record, shader, classification: classifyHgrpMaterial(record, shader), textures };
};
