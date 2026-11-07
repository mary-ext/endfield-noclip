import { createHash } from 'node:crypto';

import { type AssetRef, locateObject, objectKey, type ObjectRef } from '../../game/assets/assets.ts';
import type { RendererMotion } from '../../game/prefabs/prefab.ts';

import { type SyntheticMesh, syntheticMeshKey } from './synthetic-mesh.ts';

// the packer references assets by dense ids handed out here, in first-reference order; `convertAssets`
// converts them in id order

/** assigns dense ids to assets by hash, in first-reference order */
export class AssetIds {
	readonly assets: AssetRef[] = [];
	readonly #ids = new Map<bigint, number>();
	readonly #variants = new Map<string, number>();
	/** by id, the key of each variant, which shares its object's hash */
	readonly #variantKeys = new Map<number, string>();

	/**
	 * @param hash StringPathHash key
	 * @param resolve looks up the path, called once per new hash
	 * @returns the asset's id
	 */
	intern(hash: bigint, resolve: (hash: bigint) => string | undefined): number {
		return this.#ids.getOrInsertComputed(
			hash,
			() => this.assets.push({ hash, path: resolve(hash) ?? null }) - 1,
		);
	}

	/**
	 * interns an exact prefab dependency without inventing a game asset path
	 *
	 * @param ref resolved dependency
	 * @returns its asset id; negative hashes occupy a namespace separate from unsigned game hashes
	 */
	internObject(ref: ObjectRef): number {
		const key = objectKey(ref);
		const hash = objectHash(key);
		const existing = this.#ids.get(hash);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.assets.length;
		this.#ids.set(hash, id);
		this.assets.push({ hash, path: key, locator: locateObject(ref) });
		return id;
	}

	/**
	 * interns a variant of a prefab dependency: the same object under an id of its own, for uses that change
	 * some of its values before it's converted (see `MaterialOverrides`)
	 *
	 * @param ref resolved dependency
	 * @param variant tells variants of one object apart
	 * @returns the variant's id
	 */
	internObjectVariant(ref: ObjectRef, variant: string): number {
		const key = objectKey(ref);
		return this.#variants.getOrInsertComputed(`${key}/${variant}`, (variantKey) => {
			const id = this.assets.push({ hash: objectHash(key), path: key, locator: locateObject(ref) }) - 1;
			this.#variantKeys.set(id, variantKey);
			return id;
		});
	}

	/**
	 * @param id an asset id
	 * @returns a key naming the asset by what it is rather than by when it was first met, so orders built from
	 *   it don't shift when other assets come and go
	 */
	keyOf(id: number): string {
		return this.#variantKeys.get(id) ?? this.assets[id].hash.toString(16);
	}

	/**
	 * @param mesh a mesh the packer makes itself
	 * @returns its asset id
	 */
	internSynthetic(mesh: SyntheticMesh): number {
		const key = syntheticMeshKey(mesh);
		const hash = -BigInt(`0x${createHash('sha256').update(key).digest('hex')}`);
		return this.#ids.getOrInsertComputed(
			hash,
			() => this.assets.push({ hash, path: key, synthetic: mesh }) - 1,
		);
	}

	/**
	 * @param ref skinned mesh dependency
	 * @param pose mesh-to-prefab bone matrices, including bind poses
	 * @returns a geometry id distinct for each authored pose of the mesh
	 */
	internPosedObject(ref: ObjectRef, pose: Float32Array[]): number {
		const key = objectKey(ref);
		const digest = createHash('sha256').update(key).update('pose');
		for (const matrix of pose) {
			digest.update(new Uint8Array(matrix.buffer, matrix.byteOffset, matrix.byteLength));
		}
		const hash = -BigInt(`0x${digest.digest('hex')}`);
		const existing = this.#ids.get(hash);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.assets.length;
		this.#ids.set(hash, id);
		this.assets.push({
			hash,
			path: key,
			locator: locateObject(ref),
			pose: pose.map((matrix) => matrix.slice()),
		});
		return id;
	}

	/**
	 * @param ref mesh dependency
	 * @param motion the looping animation it plays
	 * @returns a geometry id distinct for each animation of the mesh
	 */
	internAnimatedObject(ref: ObjectRef, motion: RendererMotion): number {
		const key = objectKey(ref);
		const { kind, skin } = motion;
		const { matrices } = skin;
		const digest = createHash('sha256')
			.update(key)
			.update(`motion ${kind} ${skin.boneCount} ${skin.frameCount} ${skin.frameRate}`)
			.update(new Uint8Array(matrices.buffer, matrices.byteOffset, matrices.byteLength));
		const hash = -BigInt(`0x${digest.digest('hex')}`);
		return this.#ids.getOrInsertComputed(
			hash,
			() =>
				this.assets.push({
					hash,
					path: key,
					locator: locateObject(ref),
					motion: { kind, skin: { ...skin, matrices: matrices.slice() } },
				}) - 1,
		);
	}
}

/**
 * @param key an object's {@link objectKey}
 * @returns its hash; negative hashes occupy a namespace separate from unsigned game hashes
 */
const objectHash = (key: string): bigint => -BigInt(`0x${createHash('sha256').update(key).digest('hex')}`);
