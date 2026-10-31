import { FormatError } from '../binary/binary-reader.ts';
import { type PlainObject, type PlainResult, toPlainObject } from '../unity/plain-object.ts';
import type { TypeTreeNode } from '../unity/serialized-file.ts';
import type { TypeTreeObject } from '../unity/type-tree.ts';
import { isObject, stringField } from '../unity/values.ts';

// `HGEnvironmentPhase` MonoBehaviours (`EnvParse/Env_*.asset`): one complete environment as a list of
// `HG*Config` sections, each with an `m_active` flag. see `docs/game-data/environment.md#environment-phases`.

/** the sections read, by their field name in the phase */
export const ENVIRONMENT_SECTIONS = [
	'lightConfig',
	'skyConfig',
	'atmosphereConfig',
	'fogConfig',
	'heightFogConfig',
	'volumetricFogConfig',
	'cloudConfig',
	'windConfig',
	'lightShaftConfig',
	'colorGradingConfig',
	'autoExposureConfig',
	'shadowConfig',
	'celestialConfig',
	'starConfig',
	'rainConfig',
	'lensFlareConfig',
] as const;

/** a section's field name */
export type EnvironmentSectionName = (typeof ENVIRONMENT_SECTIONS)[number];

/** one section, converted to plain JSON */
export interface EnvironmentSection {
	/** the section's `m_active` */
	active: boolean;
	/**
	 * the section's fields under their own names (see `unity/plain-object.ts` for the value mapping), without
	 * `m_*` bookkeeping fields, colour curves, or object references other than textures, materials and lens
	 * flare data, which are `null`
	 */
	value: PlainObject;
	/** the texture references, by field path within {@link value} */
	textures: PlainResult['pptrs'];
	/** the material references (the celestial bodies' draw materials), by field path within {@link value} */
	materials: PlainResult['pptrs'];
	/**
	 * the `LensFlareDataSRP` references (the sun's lens flare), by field path within {@link value}; read them
	 * with `unity/lens-flare-data.ts`
	 */
	flares: PlainResult['pptrs'];
}

/** a decoded phase */
export interface EnvironmentPhase {
	name: string;
	sections: Record<EnvironmentSectionName, EnvironmentSection>;
}

const TEXTURE_PPTR = /^PPtr<\$?(?:Texture|Texture2D|Texture3D|Cubemap|Texture2DArray|CubemapArray)>$/;
const MATERIAL_PPTR = /^PPtr<\$?Material>$/;
const FLARE_PPTR = /^PPtr<\$?LensFlareDataSRP>$/;

/** sub-structs that are big and unused outside the editor */
const DROPPED_TYPES = new Set(['HGColorCurve']);

/**
 * @param nodes the MonoBehaviour's flattened TypeTree
 * @param object the MonoBehaviour as read with it
 * @returns the phase's name and sections
 * @throws {FormatError} if a section is missing
 */
export const readEnvironmentPhase = (
	nodes: readonly TypeTreeNode[],
	object: TypeTreeObject,
): EnvironmentPhase => {
	const { value, pptrs } = toPlainObject(nodes, object, {
		// editor-only previews (`customIVCubemapMapForEdit`) aren't shipped textures the client samples
		keepPPtr: (type, name) =>
			(TEXTURE_PPTR.test(type) || MATERIAL_PPTR.test(type) || FLARE_PPTR.test(type)) &&
			!name.endsWith('ForEdit'),
		// `m_active` is read separately below; `m_backup*`/`m_prev*` are editor state
		dropField: (name, type) => (name.startsWith('m_') && name !== 'm_Name') || DROPPED_TYPES.has(type),
	});
	const section = (name: EnvironmentSectionName): EnvironmentSection => {
		const raw = object[name];
		const converted = value[name];
		if (
			!isObject(raw) ||
			converted === undefined ||
			converted === null ||
			typeof converted !== 'object' ||
			Array.isArray(converted)
		) {
			throw new FormatError(`environment phase has no ${name}`);
		}
		const own = pptrs
			.filter((pptr) => pptr.path[0] === name)
			.map(({ path, type, pptr }) => ({ path: path.slice(1), type, pptr }));
		return {
			active: raw.m_active === undefined ? true : raw.m_active !== 0 && raw.m_active !== false,
			value: converted,
			textures: own.filter(({ type }) => TEXTURE_PPTR.test(type)),
			materials: own.filter(({ type }) => MATERIAL_PPTR.test(type)),
			flares: own.filter(({ type }) => FLARE_PPTR.test(type)),
		};
	};
	return { name: stringField(object, 'm_Name'), sections: mapSections(section) };
};

/**
 * @param fn makes one section's value
 * @returns every section's value
 */
export const mapSections = <T>(
	fn: (name: EnvironmentSectionName) => T,
): Record<EnvironmentSectionName, T> => ({
	lightConfig: fn('lightConfig'),
	skyConfig: fn('skyConfig'),
	atmosphereConfig: fn('atmosphereConfig'),
	fogConfig: fn('fogConfig'),
	heightFogConfig: fn('heightFogConfig'),
	volumetricFogConfig: fn('volumetricFogConfig'),
	cloudConfig: fn('cloudConfig'),
	windConfig: fn('windConfig'),
	lightShaftConfig: fn('lightShaftConfig'),
	colorGradingConfig: fn('colorGradingConfig'),
	autoExposureConfig: fn('autoExposureConfig'),
	shadowConfig: fn('shadowConfig'),
	celestialConfig: fn('celestialConfig'),
	starConfig: fn('starConfig'),
	rainConfig: fn('rainConfig'),
	lensFlareConfig: fn('lensFlareConfig'),
});
