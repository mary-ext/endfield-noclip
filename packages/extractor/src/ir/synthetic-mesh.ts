import { createHash } from 'node:crypto';

/** one station along a synthetic line ribbon, running along local `+x` */
export interface LineRibbonSample {
	/** distance along `+x` in metres */
	x: number;
	/** full width across `y` in metres */
	width: number;
	/** texture U coordinate */
	u: number;
	/** linear RGBA vertex colour */
	color: readonly [r: number, g: number, b: number, a: number];
}

/**
 * meshes the packer makes itself rather than reads from the install: the stand-in `cube`, a flat `polygon` at
 * y = 0 from an outline in x, z (a water volume's surface), a subdivided unit `grid` in `[0, 1]`
 * (heightfield-displaced sludge patches), or a `lineRibbon` along `+x` (a `LineRenderer` segment run)
 */
export type SyntheticMesh =
	| 'cube'
	| { kind: 'polygon'; points: readonly (readonly [x: number, z: number])[] }
	| { kind: 'grid'; cells: number }
	| { kind: 'lineRibbon'; samples: readonly LineRibbonSample[] };

/** the object key of a synthetic mesh, standing in for a mesh's `CAB-<hex>:<path id>` */
export const syntheticMeshKey = (mesh: SyntheticMesh): string => {
	if (mesh === 'cube') {
		return 'synthetic:cube';
	}
	if (mesh.kind === 'grid') {
		return `synthetic:grid:${mesh.cells}`;
	}
	if (mesh.kind === 'lineRibbon') {
		const digest = createHash('sha256');
		for (const { x, width, u, color } of mesh.samples) {
			digest.update(`${x},${width},${u},${color[0]},${color[1]},${color[2]},${color[3]};`);
		}
		return `synthetic:line:${digest.digest('hex').slice(0, 32)}`;
	}
	const digest = createHash('sha256');
	for (const [x, z] of mesh.points) {
		digest.update(`${x},${z};`);
	}
	return `synthetic:polygon:${digest.digest('hex').slice(0, 32)}`;
};
