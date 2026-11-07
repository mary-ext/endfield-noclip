/* oxlint-disable no-await-in-loop -- references are cached by the resolver */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	inverseAffine,
	multiplyMatrices,
	transformPoint,
	trsMatrix,
} from '@endfield-noclip/formats/unity/transform';
import type { ParticleForceFieldInfo } from '@endfield-noclip/package-format/particles';

import { objectKey } from '../assets/assets.ts';
import { InfluenceFilter, readForceField } from '../effects/particle-system.ts';

import type { RendererWalk } from './renderer-walk.ts';

// what the renderer walk settles once the whole hierarchy is placed, since what it depends on can come later
// in the walk

const IDENTITY = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

/**
 * moves each `PositionFollower` to its source's position, keeping its own rotation and scale, and its subtree
 * with it: their Transforms, their candidates, and the saved position looping clips pose it from
 *
 * @param walk the finished walk, updated in place
 * @throws {FormatError} if a follower's source is outside the prefab
 */
export const moveFollowers = (walk: RendererWalk): void => {
	const { transforms } = walk;
	for (const [follower, source] of walk.followers) {
		const from = transforms.get(follower);
		const to = transforms.get(source);
		if (from === undefined || to === undefined) {
			throw new FormatError(`PositionFollower follows a Transform outside its prefab`);
		}
		const delta = [to[12] - from[12], to[13] - from[13], to[14] - from[14]];
		const moved = (matrix: Float32Array): Float32Array => {
			const copy = matrix.slice();
			for (let axis = 0; axis < 3; axis++) {
				copy[12 + axis] += delta[axis];
			}
			return copy;
		};
		const subtree = new Set([follower]);
		for (const node of walk.nodes) {
			if (node.parent !== null && subtree.has(node.parent)) {
				subtree.add(node.key);
			}
			if (subtree.has(node.key)) {
				transforms.set(node.key, moved(transforms.get(node.key) ?? IDENTITY));
			}
			if (node.key === follower && node.parent !== null) {
				// looping clips pose it from here
				const parentMatrix = transforms.get(node.parent) ?? IDENTITY;
				node.saved.position = transformPoint(inverseAffine(parentMatrix), [to[12], to[13], to[14]]);
			}
		}
		for (const [candidate, transform] of walk.candidateTransforms) {
			if (subtree.has(transform)) {
				candidate.matrix = moved(candidate.matrix);
			}
		}
	}
};

/**
 * gives each played particle system the force fields it feels: those it lists, or those on its layers, within
 * this prefab (wind zones and fields elsewhere in the scene aren't followed). a field the viewer can't step
 * makes the system a stand-in
 *
 * @param walk the finished walk, whose candidates are updated in place
 */
export const resolveForces = async (walk: RendererWalk): Promise<void> => {
	for (const [candidate, { system, forces, emitter, standIn }] of walk.pendingForces) {
		const felt = new Set<string>();
		if (forces.filter !== InfluenceFilter.LayerMask) {
			for (const pointer of forces.list) {
				const ref = await walk.resolver.resolve(system, pointer);
				if (ref !== null && walk.forceFields.has(objectKey(ref))) {
					felt.add(objectKey(ref));
				}
			}
		}
		if (forces.filter !== InfluenceFilter.List) {
			for (const [key, field] of walk.forceFields) {
				if (((forces.mask >>> field.layer) & 1) !== 0) {
					felt.add(key);
				}
			}
		}
		const infos: ParticleForceFieldInfo[] = [];
		let reason: string | null = null;
		for (const key of felt) {
			const field = walk.forceFields.get(key);
			if (field === undefined) {
				continue;
			}
			const read = readForceField(field.data, multiplyMatrices(inverseAffine(field.matrix), emitter));
			if (typeof read === 'string') {
				reason = read;
				break;
			}
			infos.push(read);
		}
		const particles = candidate.particles;
		if (reason !== null) {
			candidate.particles = null;
			candidate.unsupported = reason;
			candidate.matrix = standIn;
		} else if (infos.length > 0 && particles?.motion.kind === 'free') {
			candidate.particles = {
				...particles,
				motion: { ...particles.motion, forces: { multiplier: forces.multiplier, fields: infos } },
			};
		}
	}
};
