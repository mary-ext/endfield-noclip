import { typeName, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	asPPtr,
	arrayField,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import { type Context, withContext } from '../../../context.ts';
import { errorText } from '../../../errors.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../../../game/assets/assets.ts';
import { RENDER_PIPELINE_QUAD_PATH } from '../../../game/assets/builtin-resources.ts';
import { loadMaterial } from '../../../game/materials/material-load.ts';
import { DECAL_PROJECTOR_CLASS } from '../../../game/prefabs/decal-projector.ts';
import { readPrefabEnvironmentVolumes } from '../../../game/prefabs/prefab-environment.ts';
import { readPrefabLights } from '../../../game/prefabs/prefab-lights.ts';
import { walkPrefab } from '../../../game/prefabs/prefab-walk.ts';
import { readPrefabRenderers } from '../../../game/prefabs/prefab.ts';
import { DECAL_CUBE_PATH } from '../../../pack/content/pack-content.ts';
import { collectTargets, jsonReplacer } from '../../helpers.ts';

import { describeLoadedMaterial } from './material.ts';
import type { InspectSubArgs } from './parser.ts';
import { resolveObjectArg } from './shared.ts';

/**
 * runs `endfield-extract inspect prefab`
 *
 * @param args parsed CLI arguments
 */
export const runInspectPrefab = async (args: InspectSubArgs<'prefab'>): Promise<void> => {
	const targets = await collectTargets(args.targets, args.stdin);
	if (targets.length === 0) {
		throw new Error('inspect prefab needs at least one target or --stdin');
	}
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		const jsonOut: unknown[] = [];
		for (const [index, raw] of targets.entries()) {
			if (!args.json && index > 0) {
				console.log('\n' + '─'.repeat(72) + '\n');
			}
			// oxlint-disable-next-line no-await-in-loop -- prints prefabs in target order
			const ref = await resolveObjectArg(context, resolver, raw, UnityClass.GameObject, {
				pathId: args.pathId,
				nameFilter: args.name,
			});
			// oxlint-disable-next-line no-await-in-loop -- prints prefabs in target order
			const result = await inspectPrefab(context, resolver, ref, {
				effectLod: args.effectLod,
				particles: args.particles,
				json: args.json,
			});
			if (args.json) {
				jsonOut.push(result);
			}
		}
		if (args.json) {
			console.log(JSON.stringify(targets.length === 1 ? jsonOut[0] : jsonOut, jsonReplacer, '\t'));
		}
	});
};

interface HierarchyNode {
	depth: number;
	name: string;
	pathId: string;
	active: boolean;
	position: readonly number[];
	scale: readonly number[];
	components: string[];
}

const IDENTITY_POS = (p: readonly number[]): boolean => p[0] === 0 && p[1] === 0 && p[2] === 0;
const IDENTITY_SCALE = (s: readonly number[]): boolean => s[0] === 1 && s[1] === 1 && s[2] === 1;

const findBuiltinMesh = async (
	context: Context,
	resolver: AssetResolver,
	path: string,
): Promise<ObjectRef | null> => {
	const [hash] = await context.world.hashesOf(path);
	return hash === undefined ? null : resolver.findUnique({ hash, path }, UnityClass.Mesh).catch(() => null);
};

const scriptName = async (resolver: AssetResolver, ref: ObjectRef): Promise<string> => {
	try {
		const script = await ref.file.readField(ref.info, 'm_Script');
		const scriptRef = await resolver.resolve(ref, asPPtr(script));
		if (scriptRef === null) {
			return 'MonoBehaviour';
		}
		return (await scriptRef.file.peekName(scriptRef.info)) ?? 'MonoBehaviour';
	} catch {
		return 'MonoBehaviour';
	}
};

interface RawParticleSummary {
	name: string;
	pathId: string;
	renderMode: number | null;
	simSpace: number;
	scalingMode: number;
	lengthInSec: number;
	looping: boolean;
	playOnAwake: boolean;
	maxParticles: number;
	rateOverTime: number;
	bursts: string[];
	subEmitters: { target: string; type: number; properties: number; prob: number }[];
	lights: { ratio: number; maxLights: number } | null;
	trails: boolean;
	enabledModules: string[];
}

const summarizePrefabParticles = async (
	resolver: AssetResolver,
	root: ObjectRef,
): Promise<RawParticleSummary[]> => {
	const goNames = new Map<bigint, string>();
	const renderModes = new Map<bigint, number>();
	const psById = new Map<bigint, { pathId: bigint; data: TypeTreeObject }>();
	for (const obj of root.file.file.objects) {
		if (obj.classId === UnityClass.GameObject) {
			// oxlint-disable-next-line no-await-in-loop -- peeks GameObject names in prefab file
			const name = await root.file.peekName(obj);
			if (name !== undefined) {
				goNames.set(obj.pathId, name);
			}
		} else if (obj.classId === UnityClass.ParticleSystemRenderer) {
			// oxlint-disable-next-line no-await-in-loop -- reads render mode per ParticleSystemRenderer
			const data = await resolver.read({ ...root, info: obj });
			renderModes.set(pptrField(data, 'm_GameObject').pathId, numberField(data, 'm_RenderMode'));
		} else if (obj.classId === UnityClass.ParticleSystem) {
			// oxlint-disable-next-line no-await-in-loop -- reads ParticleSystem modules
			const data = await resolver.read({ ...root, info: obj });
			psById.set(obj.pathId, { pathId: obj.pathId, data });
		}
	}
	const out: RawParticleSummary[] = [];
	for (const { pathId, data } of psById.values()) {
		const go = pptrField(data, 'm_GameObject').pathId;
		const init = objectField(data, 'InitialModule');
		const emission = objectField(data, 'EmissionModule');
		const rate = objectField(emission, 'rateOverTime');
		const bursts = arrayField(emission, 'm_Bursts')
			.filter(isObject)
			.map((b) => `${numberField(b, 'time')}@${numberField(objectField(b, 'countCurve'), 'scalar')}`);
		const sub = objectField(data, 'SubModule');
		const subEmitters = booleanField(sub, 'enabled')
			? arrayField(sub, 'subEmitters')
					.filter(isObject)
					.map((e) => {
						const targetId = pptrField(e, 'emitter').pathId;
						const targetPs = psById.get(targetId);
						const targetName =
							targetPs === undefined
								? targetId.toString()
								: (goNames.get(pptrField(targetPs.data, 'm_GameObject').pathId) ?? targetId.toString());
						return {
							target: targetName,
							type: numberField(e, 'type'),
							properties: numberField(e, 'properties'),
							prob: numberField(e, 'emitProbability'),
						};
					})
					.filter((e) => e.target !== '0' && e.prob > 0)
			: [];
		const lm = objectField(data, 'LightsModule');
		const lights =
			booleanField(lm, 'enabled') && pptrField(lm, 'light').pathId !== 0n
				? { ratio: numberField(lm, 'ratio'), maxLights: numberField(lm, 'maxLights') }
				: null;
		const tm = isObject(data.TrailModule) ? data.TrailModule : null;
		const enabledModules = Object.entries(data)
			.filter(([k, v]) => k.endsWith('Module') && isObject(v) && v.enabled === true)
			.map(([k]) => k.replace(/Module$/, ''));
		out.push({
			name: goNames.get(go) ?? go.toString(),
			pathId: pathId.toString(),
			renderMode: renderModes.get(go) ?? null,
			simSpace: numberField(data, 'moveWithTransform'),
			scalingMode: numberField(data, 'scalingMode'),
			lengthInSec: numberField(data, 'lengthInSec'),
			looping: booleanField(data, 'looping'),
			playOnAwake: booleanField(data, 'playOnAwake'),
			maxParticles: numberField(init, 'maxNumParticles'),
			rateOverTime: numberField(rate, 'scalar'),
			bursts,
			subEmitters,
			lights,
			trails: tm !== null && tm.enabled === true,
			enabledModules,
		});
	}
	return out;
};

const inspectPrefab = async (
	context: Context,
	resolver: AssetResolver,
	root: ObjectRef,
	options: { effectLod: 'camera' | 'proxy' | 'none'; particles: boolean; json: boolean },
): Promise<object> => {
	const bundleName = resolver.manifest.bundleName(root.bundleIndex);
	const rootName = (await root.file.peekName(root.info)) ?? '?';

	// 1. walk the full hierarchy (including inactive nodes) so nothing is hidden
	const hierarchy: HierarchyNode[] = [];
	const scriptNames = new Map<object, Promise<string>>();
	const cachedScriptName = (ref: ObjectRef): Promise<string> =>
		ref.info.type === undefined
			? scriptName(resolver, ref)
			: scriptNames.getOrInsertComputed(ref.info.type, () => scriptName(resolver, ref));
	let hasParticles = false;
	let hasDecal = false;
	await walkPrefab(
		resolver,
		root,
		{
			enter: (_node, depth) => depth + 1,
			visit: async (node, depth) => {
				const components: string[] = [];
				for (const component of node.components) {
					if (component.classId === UnityClass.Transform || component.classId === UnityClass.RectTransform) {
						continue;
					}
					if (
						component.classId === UnityClass.ParticleSystem ||
						component.classId === UnityClass.ParticleSystemRenderer
					) {
						hasParticles = true;
					} else if (component.classId === DECAL_PROJECTOR_CLASS) {
						hasDecal = true;
					}
					if (component.classId === UnityClass.MonoBehaviour) {
						// oxlint-disable-next-line no-await-in-loop -- keeps authored component order
						components.push(await cachedScriptName(component.ref));
					} else {
						components.push(typeName(component.ref.info.type) ?? `class:${component.classId}`);
					}
				}
				hierarchy.push({
					depth,
					name: node.name,
					pathId: node.go.info.pathId.toString(),
					active: node.active,
					position: node.saved.position,
					scale: node.saved.scale,
					components,
				});
			},
		},
		-1,
	);

	// 2. run the packer's own readers (only look up built-in fallback meshes if the prefab needs them)
	const [particleQuad, decalCube] = await Promise.all([
		hasParticles ? findBuiltinMesh(context, resolver, RENDER_PIPELINE_QUAD_PATH) : null,
		hasDecal ? findBuiltinMesh(context, resolver, DECAL_CUBE_PATH) : null,
	]);
	const [renderersResult, lightsResult, volumesResult] = await Promise.all([
		readPrefabRenderers(resolver, root, {
			viewPose: null,
			particleQuad,
			decalCube,
			locked: false,
			effectLod: options.effectLod,
		}).catch((error: unknown) => errorText(error)),
		readPrefabLights(resolver, root).catch((error: unknown) => errorText(error)),
		readPrefabEnvironmentVolumes(resolver, root, {
			position: [0, 0, 0],
			rotation: [0, 0, 0, 1],
			scale: [1, 1, 1],
		}).catch((error: unknown) => errorText(error)),
	]);

	// 3. summarize each renderer's mesh & materials (including describeMaterial), caching repeated materials
	const loadMaterialSummary = async (matRef: ObjectRef) => {
		try {
			const loaded = await loadMaterial(resolver, matRef);
			const described = describeLoadedMaterial(loaded);
			return {
				name: loaded.record.name,
				object: objectKey(matRef),
				bundle: resolver.manifest.bundleName(matRef.bundleIndex),
				shader: loaded.shader.name,
				queue: loaded.classification.renderQueue,
				blend: loaded.classification.blend,
				surface: described.surface.kind,
				...(described.surface.kind === 'unsupported' || described.surface.kind === 'undrawn'
					? { reason: described.surface.reason }
					: {}),
				...('gaps' in described.surface &&
				Array.isArray(described.surface.gaps) &&
				described.surface.gaps.length > 0
					? { gaps: described.surface.gaps }
					: {}),
			};
		} catch (error) {
			return { object: objectKey(matRef), error: errorText(error) };
		}
	};
	const materialCache = new Map<string, ReturnType<typeof loadMaterialSummary>>();
	const summarizeMaterial = (matRef: ObjectRef) =>
		materialCache.getOrInsertComputed(objectKey(matRef), () => loadMaterialSummary(matRef));
	const rendererSummaries =
		typeof renderersResult === 'string'
			? { error: renderersResult }
			: await Promise.all(
					renderersResult.map(async (renderer) => {
						const meshName =
							renderer.mesh === null
								? 'line-ribbon'
								: ((await renderer.mesh.file.peekName(renderer.mesh.info)) ?? objectKey(renderer.mesh));
						const materials = await Promise.all(
							renderer.materials.map(async (matRef) => (matRef === null ? null : summarizeMaterial(matRef))),
						);
						let kind: string = 'mesh';
						if (renderer.synthetic !== null) {
							kind = 'line';
						} else if (renderer.decal !== null) {
							kind = 'decal';
						} else if (renderer.particles !== null) {
							kind = 'particles';
						} else if (renderer.pose !== null || renderer.motion?.kind === 'skinned') {
							kind = 'skinned';
						}
						return {
							name: renderer.name,
							kind,
							mesh: meshName,
							meshObject: renderer.mesh === null ? null : objectKey(renderer.mesh),
							submeshes: renderer.submeshes,
							shadowOnly: renderer.shadowOnly,
							sorting: renderer.sorting,
							motion:
								renderer.motion === null
									? null
									: {
											kind: renderer.motion.kind,
											duration: renderer.motion.skin.frameCount / renderer.motion.skin.frameRate,
										},
							particles: renderer.particles,
							billboard: renderer.billboard,
							sizes: renderer.sizes,
							distances: renderer.distances,
							proxyLevels: renderer.proxyLevels,
							unsupported: renderer.unsupported,
							materials,
						};
					}),
				);

	const lightsSummary =
		typeof lightsResult === 'string'
			? { error: lightsResult }
			: lightsResult.map(({ name, light }) => ({
					name,
					type: light.type,
					color: light.color,
					intensity: light.intensity,
					range: light.range,
					spotAngle: light.spotAngle,
					shadows: light.shadows,
				}));

	const volumesSummary =
		typeof volumesResult === 'string'
			? { error: volumesResult }
			: await Promise.all(
					volumesResult.map(async ({ volume, phase }) => ({
						name: volume.name,
						priority: volume.priority,
						volumeType: volume.volumeType,
						blendMode: volume.blendMode,
						phase: phase === null ? null : ((await phase.file.peekName(phase.info)) ?? objectKey(phase)),
					})),
				);

	const rawParticles = options.particles ? await summarizePrefabParticles(resolver, root) : undefined;

	const output = {
		name: rootName,
		object: objectKey(root),
		bundle: bundleName,
		hierarchy,
		renderers: rendererSummaries,
		...(rawParticles === undefined ? {} : { particleSystems: rawParticles }),
		lights: lightsSummary,
		environmentVolumes: volumesSummary,
	};

	if (options.json) {
		return output;
	}

	console.log(`prefab ${rootName}  (${bundleName}  ${objectKey(root)})`);
	console.log(`\nhierarchy (${hierarchy.length} GameObjects):`);
	for (const node of hierarchy) {
		const indent = '  '.repeat(node.depth + 1);
		const off = node.active ? '' : ' [off]';
		const pos = IDENTITY_POS(node.position)
			? ''
			: ` pos(${node.position.map((v) => +v.toFixed(2)).join(',')})`;
		const scl = IDENTITY_SCALE(node.scale) ? '' : ` scl(${node.scale.map((v) => +v.toFixed(2)).join(',')})`;
		const comps = node.components.length === 0 ? '' : `  [${node.components.join(', ')}]`;
		console.log(`${indent}${node.name}${off}${pos}${scl}${comps}`);
	}

	if ('error' in rendererSummaries) {
		console.log(`\nrenderers: error: ${rendererSummaries.error}`);
	} else {
		console.log(`\nrenderers (${rendererSummaries.length}):`);
		for (const r of rendererSummaries) {
			const tags: string[] = [r.kind];
			if (r.shadowOnly) {
				tags.push('shadow-only');
			}
			if (r.sorting.layer !== 0 || r.sorting.order !== 0) {
				tags.push(`sort=${r.sorting.layer}/${r.sorting.order}`);
			}
			if (r.motion !== null) {
				tags.push(`motion:${r.motion.kind}(${r.motion.duration.toFixed(2)}s)`);
			}
			if (r.particles !== null) {
				const p = r.particles;
				const parts: string[] = [String(p.renderMode)];
				if (p.stretch !== null) {
					parts.push(
						`stretch(${p.stretch.lengthScale}/${p.stretch.velocityScale}${p.stretch.freeform ? ',freeform' : ''})`,
					);
				}
				if (p.motion.kind === 'spline') {
					parts.push('spline');
				} else if (p.motion.clamp !== null) {
					parts.push(`clamp(${p.motion.clamp.kind})`);
				}
				if (p.trail !== null) {
					parts.push('trails');
				}
				if (p.emitterMotion !== undefined) {
					parts.push('moving');
				}
				tags.push(`particles:${parts.join('+')}`);
			}
			if (r.billboard !== null) {
				tags.push('billboard');
			}
			if (r.sizes !== null) {
				tags.push(`lod:${r.sizes.map((s) => s.lod).join('/')}`);
			}
			if (r.proxyLevels !== null) {
				tags.push(`proxyMask:0x${r.proxyLevels.toString(16)}`);
			}
			if (r.unsupported !== null) {
				tags.push(`STAND-IN: ${r.unsupported}`);
			}
			console.log(`  ${r.name}  (${tags.join(', ')})  mesh=${r.mesh}`);
			for (const mat of r.materials) {
				if (mat === null) {
					console.log('    mat: (null)');
				} else if ('error' in mat) {
					console.log(`    mat: ${mat.object} ERROR: ${mat.error}`);
				} else {
					const extra: string[] = [`surface=${mat.surface}`, `q=${mat.queue}`, mat.blend];
					if ('reason' in mat && mat.reason !== undefined) {
						extra.push(`reason: ${mat.reason}`);
					}
					if ('gaps' in mat && Array.isArray(mat.gaps)) {
						extra.push(`gaps: ${mat.gaps.join(', ')}`);
					}
					console.log(`    mat: ${mat.name}  [${mat.shader}]  ${extra.join('  ')}  (${mat.bundle})`);
				}
			}
		}
	}

	if (rawParticles !== undefined && rawParticles.length > 0) {
		console.log(`\nparticle systems (${rawParticles.length}):`);
		for (const ps of rawParticles) {
			const parts = [
				`rm=${ps.renderMode ?? '-'}`,
				`sim=${ps.simSpace}`,
				`scale=${ps.scalingMode}`,
				`len=${ps.lengthInSec}`,
				`loop=${ps.looping}`,
				`awake=${ps.playOnAwake}`,
				`max=${ps.maxParticles}`,
				`rate=${ps.rateOverTime}`,
			];
			if (ps.bursts.length > 0) {
				parts.push(`bursts=${ps.bursts.join(',')}`);
			}
			if (ps.subEmitters.length > 0) {
				parts.push(
					`subs=[${ps.subEmitters.map((s) => `${s.target}:t${s.type}/p${s.properties}`).join(',')}]`,
				);
			}
			if (ps.lights !== null) {
				parts.push(`lights=${ps.lights.ratio}x${ps.lights.maxLights}`);
			}
			if (ps.trails) {
				parts.push('trails');
			}
			console.log(`  ${ps.name}  (${parts.join(', ')})  mods=[${ps.enabledModules.join(',')}]`);
		}
	}

	if ('error' in lightsSummary) {
		console.log(`\nlights: error: ${lightsSummary.error}`);
	} else if (lightsSummary.length > 0) {
		console.log(`\nlights (${lightsSummary.length}):`);
		for (const l of lightsSummary) {
			console.log(`  ${l.name}  type=${l.type}  intensity=${l.intensity}  range=${l.range}`);
		}
	}

	if ('error' in volumesSummary) {
		console.log(`\nenvironment volumes: error: ${volumesSummary.error}`);
	} else if (volumesSummary.length > 0) {
		console.log(`\nenvironment volumes (${volumesSummary.length}):`);
		for (const v of volumesSummary) {
			console.log(`  ${v.name}  priority=${v.priority}  type=${v.volumeType}  phase=${v.phase ?? '(none)'}`);
		}
	}
	return output;
};

// #endregion
