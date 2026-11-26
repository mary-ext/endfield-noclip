import { PackedPackage } from '../../../pipeline/read-package.ts';

import type { AuditSubArgs } from './parser.ts';
import { packageDirsOf, readDebugJson, tallyBy } from './shared.ts';
import { boundsDistance, formatBounds } from './tree.ts';

/**
 * runs `endfield-extract audit water`
 *
 * @param args parsed CLI arguments
 */
export const runAuditWater = async (args: AuditSubArgs<'water'>): Promise<void> => {
	const { packageDir, debugDir } = packageDirsOf(args.scene, args.dir);
	await auditWater(packageDir, debugDir, {
		near: args.near,
		radius: args.radius,
		config: args.config,
		packed: args.packed,
		json: args.json,
	});
};

/** shape of `debug/water.json` */
export interface DebugWaterFile {
	surfaces: { scene: number; packed: number };
	volumes: { scene: number; packed: number };
	global: string | null;
	sectors: { scene: number; packed: number; untiled: number };
	untiledSectors: string[];
	rows: { config: string | null; mesh: string | null; renderTypeMask?: number }[];
	errors: { asset: string; reason: string }[];
}

const auditWater = async (
	packageDir: string,
	debugDir: string,
	options: {
		near: number[] | undefined;
		radius: number;
		config: RegExp | undefined;
		packed: boolean;
		json: boolean;
	},
): Promise<void> => {
	if (options.near !== undefined || options.config !== undefined || options.packed) {
		await using pkg = await PackedPackage.open(packageDir);
		const table = await pkg.water();
		const surfaces = table.surfaces
			.map((surface, index) => ({
				index,
				kind: surface.kind,
				entityId: surface.entityId,
				group: surface.group,
				configIndex: surface.config,
				configName: table.configs[surface.config]?.name ?? '(unknown)',
				distance: options.near === undefined ? null : boundsDistance(surface.bounds, options.near),
				bounds: surface.bounds,
			}))
			.filter((row) => {
				if (options.near !== undefined && row.distance! > options.radius) {
					return false;
				}
				if (options.config !== undefined && !options.config.test(row.configName)) {
					return false;
				}
				return true;
			})
			.toSorted((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.index - b.index);
		const configIndices = new Set(surfaces.map((s) => s.configIndex));
		if (options.config !== undefined && options.near === undefined) {
			for (const [i, cfg] of table.configs.entries()) {
				if (options.config.test(cfg.name)) {
					configIndices.add(i);
				}
			}
		}
		const configs = [...configIndices]
			.toSorted((a, b) => a - b)
			.map((i) => ({ index: i, name: table.configs[i].name, values: table.configs[i].values }));
		if (options.json) {
			console.log(JSON.stringify({ surfaces, configs }, null, '\t'));
			return;
		}
		for (const s of surfaces) {
			const dist = s.distance === null ? '' : `d=${s.distance.toFixed(1)}m  `;
			console.log(
				`${dist}${s.kind.padEnd(6)}  cfg#${s.configIndex} ${s.configName.padEnd(28)} group=${s.group}  bounds=${formatBounds(s.bounds)}`,
			);
		}
		for (const cfg of configs) {
			console.log(`\n=== config #${cfg.index}: ${cfg.name} ===`);
			console.log(JSON.stringify(cfg.values, null, '\t'));
		}
		console.error(`${surfaces.length} matching surfaces, ${configs.length} configs`);
		return;
	}

	const data = await readDebugJson<DebugWaterFile>(debugDir, 'water.json');
	if (options.json) {
		console.log(JSON.stringify(data, null, '\t'));
		return;
	}
	console.log(
		`surfaces: ${data.surfaces.packed}/${data.surfaces.scene} packed  volumes: ${data.volumes.packed}/${data.volumes.scene} packed  global: ${data.global ?? '(none)'}`,
	);
	console.log(
		`sectors: ${data.sectors.packed}/${data.sectors.scene} packed (${data.sectors.untiled} untiled)  errors: ${data.errors.length}`,
	);
	const byConfig = tallyBy(
		data.rows,
		(row) => row.config?.split('/').pop() ?? '(none)',
		(row) => row.mesh?.split('##').pop() ?? '(volume)',
	);
	console.log(`\nby config (${byConfig.length}):`);
	for (const g of byConfig) {
		console.log(`  ${String(g.count).padStart(5)}  ${g.key}`);
	}
	if (data.errors.length > 0) {
		console.log(`\nerrors (${data.errors.length}):`);
		for (const err of data.errors.slice(0, 20)) {
			console.log(`  ${err.asset}: ${err.reason}`);
		}
	}
};
