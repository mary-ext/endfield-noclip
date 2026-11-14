import type { MaterialCull, ReadyMaterial } from '@endfield-noclip/package-format/materials';

/**
 * a material table entry for the look tests
 *
 * @param surface the surface the extractor described
 * @param cull the faces the material culls
 * @returns a converted material without gaps
 */
export const described = (surface: ReadyMaterial['surface'], cull: MaterialCull = 'back'): ReadyMaterial => ({
	status: 'ready',
	cull,
	surface,
	gaps: [],
});
