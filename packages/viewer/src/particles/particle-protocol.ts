import type { ParticleSystemInfo } from '@endfield-noclip/package-format/particles';

import type { ParticleView } from './row-geometry.ts';

/** messages posted from {@link ParticleField} to the particle worker */
export type ParticleWorkerMessage =
	| {
			kind: 'system';
			system: number;
			info: ParticleSystemInfo;
	  }
	| {
			kind: 'add';
			id: number;
			system: number;
			seed: number;
			start: number;
			offset: number;
			capacity: number;
			origin: [x: number, y: number, z: number];
			blockSlot: number;
	  }
	| {
			kind: 'remove';
			ids: number[];
	  }
	| {
			kind: 'step';
			seq: number;
			view: ParticleView;
			/** number of active emitters packed in {@link ids} and {@link transforms} */
			count: number;
			ids: Uint32Array<ArrayBuffer>;
			transforms: Float32Array<ArrayBuffer>;
			/** recycled counts buffer from the previous result, if any */
			counts?: Uint32Array<ArrayBuffer> | null;
			/** recycled output buffer from the previous result, if any */
			buffer: ArrayBuffer | null;
	  };

/** responses posted from the particle worker back to {@link ParticleField} */
export interface ParticleWorkerResponse {
	kind: 'result';
	seq: number;
	/** number of emitters evaluated */
	count: number;
	/** emitter ids evaluated, in the order requested (returned for ping-pong reuse) */
	ids: Uint32Array<ArrayBuffer>;
	/** transforms buffer returned for ping-pong reuse */
	transforms: Float32Array<ArrayBuffer>;
	/** row count written per emitter */
	counts: Uint32Array<ArrayBuffer>;
	/** packed GPU instance rows concatenated across all emitters, length `sum(counts) * ROW_WORDS` */
	rows: Uint32Array<ArrayBuffer>;
}
