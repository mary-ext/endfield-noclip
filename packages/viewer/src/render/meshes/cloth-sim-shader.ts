/**
 * GPU cloth simulation compute shader: port of Endfield's `ClothSingleDispatchCS` (`ClothSimMain`). one
 * workgroup of 256 threads simulates one cloth (1 or 2 batches of up to 256 nodes each), integrating wind
 * lift/drag + gravity via Verlet, solving distance, collision-plane, max-deviation, and anchor constraints in
 * workgroup shared memory, and writing each node's 3x4 object-space skinning matrix.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

/** uniform parameters for {@link csClothSim} */
export const ClothUniformsSchema = d.struct({
	/** x = dt (0.023333333), y = 1 / dt, z = loopNum, w = unused */
	dtInfo: d.vec4f,
	/** x = windTime, yz = windNoiseUv, w = unused */
	windParams: d.vec4f,
	/** x = windIntensity (`_WindGlobalParams0.x`), y = unused, zw = windDir.xz */
	windGlobal: d.vec4f,
});

/** bind group layout for {@link csClothSim} */
export const clothSimLayout = tgpu.bindGroupLayout({
	params: { uniform: ClothUniformsSchema },
	clothMeta: { storage: d.arrayOf(d.arrayOf(d.u32, 44)), access: 'readonly' },
	batchMeta: { storage: d.arrayOf(d.vec4i), access: 'readonly' },
	cacheMap: { storage: d.arrayOf(d.vec4u), access: 'readonly' },
	clothNodes: { storage: d.arrayOf(d.arrayOf(d.u32, 48)), access: 'mutable' },
	skeletons: { storage: d.arrayOf(d.vec4f), access: 'mutable' },
	windNoise: { texture: d.texture2d(d.f32) },
	windSampler: { sampler: 'filtering' },
});

/** 0..255 = ping buffer, 256..511 = pong buffer, 512..639 = cross-batch neighbor cache */
const sharedPos = tgpu.workgroupVar(d.arrayOf(d.vec3f, 640));
/** 0..255 = batch node UVs, 256..383 = cross-batch neighbor UVs */
const sharedUv = tgpu.workgroupVar(d.arrayOf(d.vec2f, 384));

const mf32 = tgpu.fn(
	[d.u32, d.u32],
	d.f32,
)((cloth, word) => {
	'use gpu';
	return std.bitcast(d.u32, d.f32)(clothSimLayout.$.clothMeta[cloth][word]);
});

const nf32 = tgpu.fn(
	[d.u32, d.u32],
	d.f32,
)((node, word) => {
	'use gpu';
	return std.bitcast(d.u32, d.f32)(clothSimLayout.$.clothNodes[node][word]);
});

const ni32 = tgpu.fn(
	[d.u32, d.u32],
	d.i32,
)((node, word) => {
	'use gpu';
	return std.bitcast(d.u32, d.i32)(clothSimLayout.$.clothNodes[node][word]);
});

const readSharedPos = tgpu.fn(
	[d.i32, d.u32],
	d.vec3f,
)((idx, pingOffset) => {
	'use gpu';
	const u = d.u32(idx);
	const slot = std.select(u, u + pingOffset, u < 256);
	return d.vec3f(sharedPos.$[slot]);
});

const readSharedUv = tgpu.fn(
	[d.i32],
	d.vec2f,
)((idx) => {
	'use gpu';
	const u = d.u32(idx);
	const slot = std.select(u - 256, u, u < 256);
	return d.vec2f(sharedUv.$[slot]);
});

const safeSign = tgpu.fn(
	[d.f32],
	d.f32,
)((x) => {
	'use gpu';
	return std.select(std.select(d.f32(0), d.f32(-1), x < 0), d.f32(1), x > 0);
});

/** compute entrypoint simulating one cloth per 256-thread workgroup */
export const csClothSim = tgpu.computeFn({
	workgroupSize: [256, 1, 1],
	in: {
		wgId: d.builtin.workgroupId,
		localId: d.builtin.localInvocationId,
	},
})((input) => {
	'use gpu';
	const params = clothSimLayout.$.params;
	const clothIdx = input.wgId.x;
	const tid = input.localId.x;

	const rawNodeStart = clothSimLayout.$.clothMeta[clothIdx][0];
	const rawNodeEnd = clothSimLayout.$.clothMeta[clothIdx][1];
	const rawBatchStart = clothSimLayout.$.clothMeta[clothIdx][2];
	const iterNum = clothSimLayout.$.clothMeta[clothIdx][3];

	const damping = mf32(clothIdx, 4);
	const windFreqFactor = mf32(clothIdx, 5);
	const windBalanceFactor = mf32(clothIdx, 6);
	const windIntensityScale = mf32(clothIdx, 7);

	const groupNodeOffset = std.bitcast(d.u32, d.i32)(clothSimLayout.$.clothMeta[clothIdx][8]);
	const groupBatchOffset = std.bitcast(d.u32, d.i32)(clothSimLayout.$.clothMeta[clothIdx][9]);
	const groupCacheOffset = std.bitcast(d.u32, d.i32)(clothSimLayout.$.clothMeta[clothIdx][10]);

	const longestAnchorDist = mf32(clothIdx, 12);
	const softClampFlag = mf32(clothIdx, 13) !== 0;
	const windSpatialScale = mf32(clothIdx, 14);

	const clothNormal = d.vec3f(mf32(clothIdx, 16), mf32(clothIdx, 17), mf32(clothIdx, 18));

	const l2w0 = d.vec4f(mf32(clothIdx, 20), mf32(clothIdx, 21), mf32(clothIdx, 22), mf32(clothIdx, 23));
	const l2w1 = d.vec4f(mf32(clothIdx, 24), mf32(clothIdx, 25), mf32(clothIdx, 26), mf32(clothIdx, 27));
	const l2w2 = d.vec4f(mf32(clothIdx, 28), mf32(clothIdx, 29), mf32(clothIdx, 30), mf32(clothIdx, 31));

	const w2l0 = d.vec4f(mf32(clothIdx, 32), mf32(clothIdx, 33), mf32(clothIdx, 34), mf32(clothIdx, 35));
	const w2l1 = d.vec4f(mf32(clothIdx, 36), mf32(clothIdx, 37), mf32(clothIdx, 38), mf32(clothIdx, 39));
	const w2l2 = d.vec4f(mf32(clothIdx, 40), mf32(clothIdx, 41), mf32(clothIdx, 42), mf32(clothIdx, 43));

	const nodeStart = d.u32(d.i32(rawNodeStart) + groupNodeOffset);
	const nodeEnd = d.u32(d.i32(rawNodeEnd) + groupNodeOffset);
	const batchStart = d.u32(d.i32(rawBatchStart) + groupBatchOffset);

	const nodeCount = nodeEnd - nodeStart;
	const batchCount = (nodeCount + 255) >>> 8;
	const loopNum = d.u32(params.dtInfo.z);
	const dt = params.dtInfo.x;
	const invDt = params.dtInfo.y;
	const dt2 = dt * dt;

	const windStrength = std.clamp(params.windGlobal.x * 0.5, 0, 1);
	const effectiveIntensity = windIntensityScale * windStrength;
	const rawDirXz = params.windGlobal.zw;
	const baseWindDir = std.select(
		d.vec3f(rawDirXz.x, 0, rawDirXz.y),
		d.vec3f(0, 0, 1),
		std.dot(rawDirXz, rawDirXz) < 0.99,
	);
	const windDir = std.normalize(std.mix(baseWindDir, clothNormal, std.abs(windBalanceFactor)));
	const noiseMix = std.clamp(effectiveIntensity * 0.3, 0, 1);
	const windAmp = effectiveIntensity * 1.6;
	const windFreq = windFreqFactor * 10 * (effectiveIntensity * 0.6 + 1);

	const l2wC0 = d.vec3f(l2w0.x, l2w1.x, l2w2.x);
	const l2wC1 = d.vec3f(l2w0.y, l2w1.y, l2w2.y);
	const l2wC2 = d.vec3f(l2w0.z, l2w1.z, l2w2.z);
	const l2wC3 = d.vec4f(l2w0.w, l2w1.w, l2w2.w, 1);

	for (let batch = d.u32(0); batch < batchCount; batch++) {
		const batchNodeStart = nodeStart + batch * 256;
		const batchNodeEnd = std.min(nodeEnd, batchNodeStart + 256);
		const nodeIdx = batchNodeStart + tid;
		const isActive = nodeIdx < batchNodeEnd;

		const batchGlobal = batchStart + batch;
		const batchPair = clothSimLayout.$.batchMeta[batchGlobal >>> 1];
		const cacheRangeLocal = std.select(batchPair.xy, batchPair.zw, (batchGlobal & 1) !== 0);
		const cacheStart = cacheRangeLocal.x + groupCacheOffset;
		const cacheEnd = cacheRangeLocal.y + groupCacheOffset;
		const hasCache = d.i32(tid) < cacheEnd - cacheStart;

		let cacheSrcNode = d.u32(0);
		let cachePosSlot = d.u32(0);
		let cacheUvSlot = d.u32(0);
		if (hasCache) {
			const cacheIdx = d.u32(cacheStart) + tid;
			const pair = clothSimLayout.$.cacheMap[cacheIdx >>> 1];
			const entry = std.select(pair.xy, pair.zw, (cacheIdx & 1) !== 0);
			cacheSrcNode = d.u32(groupNodeOffset + d.i32(entry.x));
			cachePosSlot = entry.y;
			cacheUvSlot = std.select(entry.y - 256, entry.y, entry.y < 256);
		}

		let anchorIdx = d.vec2i(-1, -1);
		let anchorDist = d.vec2f(0);
		let myUv = d.vec2f(0);
		let plane = d.vec4f(0);
		let basePos = d.vec4f(0);
		let baseNormal = d.vec3f(0, 1, 0);
		let baseTangent = d.vec4f(1, 0, 0, 1);
		let prevPos = d.vec3f(0);
		let curPos = d.vec3f(0);
		let curNormal = d.vec3f(0, 1, 0);
		let nbrIdxLo = d.vec4i(-1);
		let nbrIdxHi = d.vec4i(-1);
		let nbrDistLo = d.vec4f(0);
		let nbrDistHi = d.vec4f(0);

		if (isActive) {
			anchorIdx = d.vec2i(ni32(nodeIdx, 0), ni32(nodeIdx, 1));
			anchorDist = d.vec2f(nf32(nodeIdx, 2), nf32(nodeIdx, 3));
			myUv = d.vec2f(nf32(nodeIdx, 4), nf32(nodeIdx, 5));
			basePos = d.vec4f(nf32(nodeIdx, 8), nf32(nodeIdx, 9), nf32(nodeIdx, 10), nf32(nodeIdx, 11));
			baseNormal = d.vec3f(nf32(nodeIdx, 12), nf32(nodeIdx, 13), nf32(nodeIdx, 14));
			baseTangent = d.vec4f(nf32(nodeIdx, 16), nf32(nodeIdx, 17), nf32(nodeIdx, 18), nf32(nodeIdx, 19));
			prevPos = d.vec3f(nf32(nodeIdx, 20), nf32(nodeIdx, 21), nf32(nodeIdx, 22));
			curPos = d.vec3f(nf32(nodeIdx, 24), nf32(nodeIdx, 25), nf32(nodeIdx, 26));
			curNormal = d.vec3f(nf32(nodeIdx, 28), nf32(nodeIdx, 29), nf32(nodeIdx, 30));
			plane = d.vec4f(nf32(nodeIdx, 6), nf32(nodeIdx, 7), nf32(nodeIdx, 15), nf32(nodeIdx, 23));
			nbrIdxLo = d.vec4i(ni32(nodeIdx, 32), ni32(nodeIdx, 33), ni32(nodeIdx, 34), ni32(nodeIdx, 35));
			nbrIdxHi = d.vec4i(ni32(nodeIdx, 36), ni32(nodeIdx, 37), ni32(nodeIdx, 38), ni32(nodeIdx, 39));
			nbrDistLo = d.vec4f(nf32(nodeIdx, 40), nf32(nodeIdx, 41), nf32(nodeIdx, 42), nf32(nodeIdx, 43));
			nbrDistHi = d.vec4f(nf32(nodeIdx, 44), nf32(nodeIdx, 45), nf32(nodeIdx, 46), nf32(nodeIdx, 47));
		}

		let nextPos = d.vec3f(curPos);
		let ping = d.u32(0);

		for (let step = d.u32(0); step < loopNum; step++) {
			if (isActive) {
				if (step > 0) {
					prevPos = d.vec3f(curPos);
					curPos = d.vec3f(nextPos);
				}
				const normAnchor = std.clamp(anchorDist.x / longestAnchorDist, 0, 1);
				const noiseUv = std.add(std.mul(curPos.xz, 0.05), params.windParams.yz);
				const noise = std.textureSampleLevel(
					clothSimLayout.$.windNoise,
					clothSimLayout.$.windSampler,
					noiseUv,
					0,
				).xy;
				const nBlend = std.mix(noise.x, noise.y, noiseMix);
				const spatial = nBlend * std.dot(curPos, windDir) * windSpatialScale * 0.08;
				const phase = windFreq * params.windParams.x + normAnchor * 0.62831855 + spatial;
				const waves = std.add(
					std.sin(std.mul(d.vec3f(1, noise.x, noise.y), phase)),
					d.vec3f(windBalanceFactor),
				);
				const windScalar = (waves.x + waves.y * 0.3 + waves.z * 0.6) * (windAmp * normAnchor);

				const vel = std.sub(curPos, prevPos);
				const relWind = std.sub(std.mul(windDir, windScalar), std.mul(vel, invDt));
				const relSpeed2 = std.dot(relWind, relWind);
				const relSpeed = std.sqrt(relSpeed2);
				const relDir = std.select(std.div(relWind, relSpeed), d.vec3f(0), relSpeed < 0.001);
				const ndot = std.dot(relDir, curNormal);
				const s = safeSign(ndot);
				const lift = std.mul(std.mul(curNormal, s), relSpeed2 * 0.4);
				const drag = std.mul(relDir, ndot * s * 0.3);
				const accel = std.add(std.add(lift, drag), d.vec3f(0, -5, 0));

				const p = std.add(std.add(curPos, std.mul(vel, damping)), std.mul(accel, dt2));
				const toBase = std.sub(basePos.xyz, p);
				const dist = std.length(toBase);
				const limit = std.min(basePos.w, std.max(dist, 1.5));
				const excess = std.max(dist - limit, 0);
				nextPos = std.add(p, std.mul(toBase, excess / std.max(dist, 1e-4)));
			}

			if (step === 0) {
				if (isActive) {
					sharedPos.$[tid] = d.vec3f(nextPos);
					sharedUv.$[tid] = d.vec2f(myUv);
				}
				if (hasCache) {
					sharedPos.$[cachePosSlot] = d.vec3f(
						nf32(cacheSrcNode, 24),
						nf32(cacheSrcNode, 25),
						nf32(cacheSrcNode, 26),
					);
					sharedUv.$[cacheUvSlot] = d.vec2f(nf32(cacheSrcNode, 4), nf32(cacheSrcNode, 5));
				}
			} else if (isActive) {
				sharedPos.$[tid] = d.vec3f(nextPos);
			}
			std.workgroupBarrier();

			ping = 0;
			for (let iter = d.u32(0); iter < iterNum; iter++) {
				if (isActive) {
					const readOff = ping << 8;
					const myP = d.vec3f(sharedPos.$[readOff + tid]);
					let sumP = d.vec3f(0);
					let sumW = d.f32(0);

					const nbrs = d.arrayOf(
						d.i32,
						8,
					)([nbrIdxLo.x, nbrIdxLo.y, nbrIdxLo.z, nbrIdxLo.w, nbrIdxHi.x, nbrIdxHi.y, nbrIdxHi.z, nbrIdxHi.w]);
					const dists = d.arrayOf(
						d.f32,
						8,
					)([
						nbrDistLo.x,
						nbrDistLo.y,
						nbrDistLo.z,
						nbrDistLo.w,
						nbrDistHi.x,
						nbrDistHi.y,
						nbrDistHi.z,
						nbrDistHi.w,
					]);
					for (let k = d.u32(0); k < 8; k++) {
						const ni = nbrs[k];
						if (ni >= 0) {
							const np = readSharedPos(ni, readOff);
							const delta = std.sub(np, myP);
							const dist = std.length(delta);
							const corr = std.mul(delta, (dist - dists[k]) / (2 * std.max(dist, 1e-6)));
							const dstP = std.add(myP, corr);
							const w = std.max(std.length(corr), 0.001);
							sumP = std.add(sumP, std.mul(dstP, w));
							sumW += w;
						}
					}
					const solved = std.select(myP, std.div(sumP, sumW), sumW > 0);
					ping = 1 - ping;
					sharedPos.$[(ping << 8) + tid] = d.vec3f(solved);
				}
				std.workgroupBarrier();

				if (isActive) {
					const slot = (ping << 8) + tid;
					const p = d.vec3f(sharedPos.$[slot]);
					const pen = std.max(-std.dot(plane, d.vec4f(p, 1)), 0);
					sharedPos.$[slot] = std.add(p, std.mul(plane.xyz, pen));
				}
				std.workgroupBarrier();
			}

			if (isActive) {
				const slot = (ping << 8) + tid;
				const p = d.vec3f(sharedPos.$[slot]);
				const toBase = std.sub(basePos.xyz, p);
				const dist = std.length(toBase);
				let corr = d.vec3f(0);
				if (softClampFlag && basePos.w !== 0 && basePos.w < dist) {
					corr = std.mul(toBase, ((dist - basePos.w) / (2 * dist)) * 0.1);
				} else {
					corr = std.mul(toBase, std.max(dist - basePos.w, 0) / std.max(dist, 0.001));
				}
				sharedPos.$[slot] = std.add(p, corr);
			}
			std.workgroupBarrier();

			if (isActive) {
				const readOff = ping << 8;
				const slot = readOff + tid;
				let p = d.vec3f(sharedPos.$[slot]);
				if (anchorIdx.x !== -1) {
					const ap = readSharedPos(anchorIdx.x, readOff);
					const dvec = std.sub(ap, p);
					const d2 = std.dot(dvec, dvec);
					const dist = std.sqrt(d2);
					const excess = std.max(dist - anchorDist.x, 0);
					p = std.add(p, std.mul(dvec, excess * std.inverseSqrt(std.max(d2, 1e-12))));
				}
				if (anchorIdx.y !== -1) {
					const ap = readSharedPos(anchorIdx.y, readOff);
					const dvec = std.sub(ap, p);
					const d2 = std.dot(dvec, dvec);
					const dist = std.sqrt(d2);
					const excess = std.max(dist - anchorDist.y, 0);
					p = std.add(p, std.mul(dvec, excess * std.inverseSqrt(std.max(d2, 1e-12))));
				}
				nextPos = d.vec3f(p);
				sharedPos.$[slot] = d.vec3f(p);
			}
			std.workgroupBarrier();
		}

		if (isActive) {
			const readOff = ping << 8;
			const finalPos = d.vec3f(nextPos);

			let sumN = d.vec3f(0);
			let sumT = d.vec3f(0);
			let sumB = d.vec3f(0);

			const nbrs = d.arrayOf(
				d.i32,
				8,
			)([nbrIdxLo.x, nbrIdxLo.y, nbrIdxLo.z, nbrIdxLo.w, nbrIdxHi.x, nbrIdxHi.y, nbrIdxHi.z, nbrIdxHi.w]);
			if (nbrs[0] >= 0) {
				let prevDp = std.sub(readSharedPos(nbrs[0], readOff), finalPos);
				let prevDuv = std.sub(readSharedUv(nbrs[0]), myUv);
				for (let k = d.u32(1); k < 8; k++) {
					const ni = nbrs[k];
					if (ni >= 0) {
						const dp = std.sub(readSharedPos(ni, readOff), finalPos);
						const duv = std.sub(readSharedUv(ni), myUv);
						sumN = std.add(sumN, std.cross(prevDp, dp));
						const det = prevDuv.x * duv.y - prevDuv.y * duv.x;
						if (std.abs(det) > 1e-5) {
							const invDet = 1 / det;
							sumT = std.add(sumT, std.mul(std.sub(std.mul(duv.y, prevDp), std.mul(prevDuv.y, dp)), invDet));
							sumB = std.add(sumB, std.mul(std.sub(std.mul(prevDuv.x, dp), std.mul(duv.x, prevDp)), invDet));
						}
						prevDp = d.vec3f(dp);
						prevDuv = d.vec2f(duv);
					}
				}
			}

			const n = std.mul(sumN, std.inverseSqrt(std.max(std.dot(sumN, sumN), 1.17549435e-38)));
			const tRaw = d.vec3f(
				std.select(sumT.x, 0, sumT.x === 0),
				std.select(sumT.y, 0, sumT.y === 0),
				std.select(sumT.z, 1, sumT.z === 0),
			);
			const tOrth = std.sub(tRaw, std.mul(n, std.dot(n, tRaw)));
			const t = std.mul(tOrth, std.inverseSqrt(std.max(std.dot(tOrth, tOrth), 1.17549435e-38)));
			const bRaw = std.cross(n, t);
			const b = std.mul(bRaw, safeSign(std.dot(bRaw, sumB)));

			const baseB = std.mul(std.cross(baseNormal, baseTangent.xyz), baseTangent.w);
			const negBase = std.neg(basePos.xyz);
			const invT = d.vec4f(
				std.dot(baseTangent.xyz, negBase),
				std.dot(baseB, negBase),
				std.dot(baseNormal, negBase),
				1,
			);
			const bx = d.vec3f(baseTangent.x, baseB.x, baseNormal.x);
			const by = d.vec3f(baseTangent.y, baseB.y, baseNormal.y);
			const bz = d.vec3f(baseTangent.z, baseB.z, baseNormal.z);

			const c0 = d.vec4f(t.x, b.x, n.x, finalPos.x);
			const c1 = d.vec4f(t.y, b.y, n.y, finalPos.y);
			const c2 = d.vec4f(t.z, b.z, n.z, finalPos.z);

			const mw0 = d.vec4f(std.dot(c0.xyz, bx), std.dot(c0.xyz, by), std.dot(c0.xyz, bz), std.dot(c0, invT));
			const mw1 = d.vec4f(std.dot(c1.xyz, bx), std.dot(c1.xyz, by), std.dot(c1.xyz, bz), std.dot(c1, invT));
			const mw2 = d.vec4f(std.dot(c2.xyz, bx), std.dot(c2.xyz, by), std.dot(c2.xyz, bz), std.dot(c2, invT));

			const mwlC0 = d.vec3f(std.dot(mw0.xyz, l2wC0), std.dot(mw1.xyz, l2wC0), std.dot(mw2.xyz, l2wC0));
			const mwlC1 = d.vec3f(std.dot(mw0.xyz, l2wC1), std.dot(mw1.xyz, l2wC1), std.dot(mw2.xyz, l2wC1));
			const mwlC2 = d.vec3f(std.dot(mw0.xyz, l2wC2), std.dot(mw1.xyz, l2wC2), std.dot(mw2.xyz, l2wC2));
			const mwlC3 = d.vec4f(std.dot(mw0, l2wC3), std.dot(mw1, l2wC3), std.dot(mw2, l2wC3), 1);

			const skelBase = nodeIdx * 3;
			clothSimLayout.$.skeletons[skelBase] = d.vec4f(
				std.dot(w2l0.xyz, mwlC0),
				std.dot(w2l0.xyz, mwlC1),
				std.dot(w2l0.xyz, mwlC2),
				std.dot(w2l0, mwlC3),
			);
			clothSimLayout.$.skeletons[skelBase + 1] = d.vec4f(
				std.dot(w2l1.xyz, mwlC0),
				std.dot(w2l1.xyz, mwlC1),
				std.dot(w2l1.xyz, mwlC2),
				std.dot(w2l1, mwlC3),
			);
			clothSimLayout.$.skeletons[skelBase + 2] = d.vec4f(
				std.dot(w2l2.xyz, mwlC0),
				std.dot(w2l2.xyz, mwlC1),
				std.dot(w2l2.xyz, mwlC2),
				std.dot(w2l2, mwlC3),
			);

			clothSimLayout.$.clothNodes[nodeIdx][20] = std.bitcast(d.f32, d.u32)(curPos.x);
			clothSimLayout.$.clothNodes[nodeIdx][21] = std.bitcast(d.f32, d.u32)(curPos.y);
			clothSimLayout.$.clothNodes[nodeIdx][22] = std.bitcast(d.f32, d.u32)(curPos.z);
			clothSimLayout.$.clothNodes[nodeIdx][24] = std.bitcast(d.f32, d.u32)(finalPos.x);
			clothSimLayout.$.clothNodes[nodeIdx][25] = std.bitcast(d.f32, d.u32)(finalPos.y);
			clothSimLayout.$.clothNodes[nodeIdx][26] = std.bitcast(d.f32, d.u32)(finalPos.z);
			clothSimLayout.$.clothNodes[nodeIdx][28] = std.bitcast(d.f32, d.u32)(n.x);
			clothSimLayout.$.clothNodes[nodeIdx][29] = std.bitcast(d.f32, d.u32)(n.y);
			clothSimLayout.$.clothNodes[nodeIdx][30] = std.bitcast(d.f32, d.u32)(n.z);
		}
		std.workgroupBarrier();
	}
});
