import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

/** a placed interactive, before runtime scripts and facility upgrades */
export interface LevelInteractive {
	id: bigint;
	template: string;
	createState: number;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
	modelScale: number;
}

/** an unimplemented field; callers may report and omit the entire file, never scan past it */
export class UnsupportedLevelData extends FormatError {}

/**
 * reads the sequential LevelData prefix through its interactive placements. supports factory scenery;
 * unsupported populated fields fail closed. the remaining LevelData members are not decoded
 *
 * @param bytes pooled MemoryPack LevelData
 * @param string resolves pooled string ids
 * @returns placements from the complete interactive list
 * @throws {UnsupportedLevelData} for unsupported populated fields or conditions
 * @throws {FormatError} for malformed framing
 */
export const readLevelInteractives = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): LevelInteractive[] => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	let field = 'root';
	const unsupported = (): never => {
		throw new UnsupportedLevelData(`unsupported LevelData ${field} at ${r.offset}`);
	};
	const marker = (n: number): void => {
		if (r.u8() !== n) {
			throw new FormatError(`invalid LevelData ${field} member count at ${r.offset - 1}`);
		}
	};
	const count = (): number => {
		const n = r.i32();
		if (n < -1 || n > 100_000) {
			throw new FormatError(`invalid LevelData ${field} count ${n}`);
		}
		return Math.max(n, 0);
	};
	const list = (read: () => void): void => {
		const n = count();
		for (let i = 0; i < n; i++) {
			read();
		}
	};
	const empty = (): void => {
		if (count() !== 0) {
			unsupported();
		}
	};
	const bool = (): void => {
		if (r.u8() > 1) {
			throw new FormatError(`invalid LevelData ${field} boolean`);
		}
	};
	const str = (): string | null => string(r.i32());
	const vec = (): [number, number, number] => [r.f32(), r.f32(), r.f32()];
	const nullable = (members: number, read: () => void): void => {
		const n = r.u8();
		if (n === 255) {
			return;
		}
		if (n !== members) {
			throw new FormatError(`invalid LevelData ${field} member count ${n}`);
		}
		read();
	};
	const condition = (depth: number): void => {
		if (depth > 32) {
			throw new FormatError('LevelData condition nesting exceeds 32');
		}
		const tag = r.u8();
		switch (tag) {
			case 255: {
				return;
			}
			case 0: {
				marker(3);
				r.i32();
				bool();
				list(() => condition(depth + 1));
				return;
			}
			case 12: {
				marker(1);
				str();
				return;
			}
			case 13:
			case 18: {
				marker(3);
				r.i32();
				r.i32();
				str();
				return;
			}
			default: {
				unsupported();
			}
		}
	};
	const ints = (): void => {
		r.skip(count() * 4);
	};
	const entity = (): Omit<LevelInteractive, 'modelScale'> => {
		r.i32();
		r.u64();
		const createState = r.i32();
		r.u64();
		const template = str();
		r.i32();
		bool();
		bool();
		const id = r.u64();
		bool();
		const position = vec(),
			rotation = vec(),
			scale = vec();
		bool();
		return { id, template: template ?? '', createState, position, rotation, scale };
	};
	const bound = (): void => {
		nullable(2, () => r.skip(24));
	};
	const area = (): void => {
		nullable(6, () => {
			r.skip(8);
			bool();
			r.i32();
			list(() =>
				nullable(2, () => {
					r.i32();
					list(bound);
				}),
			);
			r.i32();
		});
	};
	const mine = (): void => {
		nullable(7, () => {
			ints();
			str();
			r.u64();
			r.skip(8);
			str();
			marker(3);
			r.skip(24);
		});
	};
	const param = (): void => {
		marker(2);
		str();
		marker(2);
		r.i32();
		list(() => {
			marker(2);
			r.i64();
			str();
		});
	};
	marker(43);
	field = 'airWalls';
	const missionCheck = (): void => {
		nullable(4, () => {
			r.i32();
			str();
			bool();
			bool();
		});
	};
	list(() =>
		nullable(8, () => {
			bound();
			nullable(2, () => {
				r.i32();
				nullable(4, () => {
					list(missionCheck);
					bool();
					bool();
					list(missionCheck);
				});
			});
			bool();
			r.u64();
			list(() =>
				nullable(10, () => {
					bound();
					bool();
					bool();
					r.skip(8);
					str();
					r.skip(count() * 8);
					r.skip(20);
				}),
			);
			str();
			r.u64();
			r.u32();
		}),
	);
	field = 'aiTransData';
	empty();
	field = 'autoSpawnedInteractives';
	r.skip(count() * 8);
	field = 'blackbox';
	if (r.u8() !== 255) {
		unsupported();
	}
	field = 'buildableCondition';
	condition(0);
	for (const name of ['cameraPoses', 'charPatrol']) {
		field = name;
		empty();
	}
	field = 'doodadGroup';
	list(() => {
		marker(9);
		r.skip(24);
		r.skip(count() * 8);
		for (let i = 0; i < 4; i++) {
			ints();
		}
		r.i32();
	});
	field = 'dynamicOccludeAreas';
	list(() =>
		nullable(3, () => {
			r.i32();
			condition(0);
			list(() =>
				nullable(3, () => {
					r.i32();
					list(() => {
						marker(2);
						r.skip(12);
					});
					r.i32();
				}),
			);
		}),
	);
	field = 'enemies';
	list(() =>
		nullable(30, () => {
			entity();
			empty();
			nullable(19, () => {
				bool();
				r.f32();
				str();
				str();
				r.f32();
				str();
				r.i32();
				bool();
				bool();
				empty();
				str();
				str();
				r.f32();
				str();
				r.i32();
				bool();
				str();
				bool();
				list(() => {
					str();
				});
			});
			str();
			empty();
			r.skip(16);
			// Nullable<float> is an unmanaged eight-byte value: hasValue, padding, float bits.
			r.skip(8);
			list(() => {
				str();
			});
			bool();
			r.i32();
			nullable(3, () => r.skip(12));
			str();
			bool();
			r.i32();
			bool();
		}),
	);
	field = 'enemyGroup';
	list(() =>
		nullable(8, () => {
			r.skip(8);
			bool();
			r.u64();
			r.f32();
			list(() =>
				nullable(3, () => {
					nullable(3, () => {
						r.u64();
						r.u32();
						bool();
					});
					bool();
					r.skip(8);
				}),
			);
			r.f32();
			str();
		}),
	);
	field = 'enemyPatrol';
	list(() =>
		nullable(3, () => {
			r.i32();
			r.u64();
			list(() =>
				nullable(3, () => {
					empty();
					r.i32();
					r.skip(12);
				}),
			);
		}),
	);
	field = 'environmentVolumes';
	empty();
	field = 'factoryMines';
	list(mine);
	field = 'factoryPredefineData';
	nullable(1, empty);
	field = 'factoryRegions';
	list(() =>
		nullable(26, () => {
			entity();
			list(area);
			empty();
			list(() =>
				nullable(6, () => {
					r.skip(12);
					bool();
					str();
					str();
					r.skip(24);
				}),
			);
			list(area);
			empty();
			empty();
			bool();
			list(mine);
			r.i32();
			str();
			empty();
			list(() =>
				nullable(2, () => {
					str();
					list(bound);
				}),
			);
		}),
	);
	field = 'functionArea';
	nullable(4, () => {
		// two shipped layouts differ by the factory-hide fields; neither is a byte-pattern search.
		list(() => {
			const members = r.u8();
			if (members === 255) {
				return;
			}
			if (members !== 13 && members !== 15) {
				unsupported();
			}
			r.f32();
			bool();
			if (members === 15) {
				bool();
			}
			r.skip(12);
			if (members === 15) {
				nullable(7, () => {
					for (let i = 0; i < 5; i++) {
						bool();
					}
					r.i32();
					ints();
				});
			}
			r.i32();
			bool();
			r.i32();
			r.skip(12);
			r.skip(count() * 8);
			r.skip(40);
		});
		list(() =>
			nullable(2, () => {
				condition(0);
				r.u64();
			}),
		);
		list(bound);
		list(() => {
			switch (r.u8()) {
				case 255: {
					return;
				}
				case 12: {
					marker(2);
					r.f32();
					bool();
					return;
				}
				case 15: {
					marker(6);
					r.skip(8);
					bool();
					bool();
					r.skip(count() * 12);
					r.skip(count() * 12);
					return;
				}
				default: {
					unsupported();
				}
			}
		});
	});
	field = 'guideHints';
	empty();
	field = 'interactiveLockData';
	const lang = (): void => {
		nullable(1, () => {
			str();
		});
	};
	list(() =>
		nullable(2, () => {
			list(() =>
				nullable(18, () => {
					r.u64();
					list(() => {
						str();
					});
					lang();
					str();
					lang();
					lang();
					lang();
					lang();
					str();
					bool();
					lang();
					str();
					bool();
					bool();
					str();
					lang();
					lang();
					r.i32();
				}),
			);
			r.u64();
		}),
	);
	field = 'interactives';
	const result: LevelInteractive[] = [];
	list(() => {
		marker(25);
		const row = entity();
		list(() => {
			r.i32();
			list(param);
		});
		ints();
		list(param);
		bool();
		bool();
		bool();
		ints();
		list(param);
		const modelScale = r.f32();
		condition(0);
		list(param);
		result.push({ ...row, modelScale });
	});
	return result;
};
