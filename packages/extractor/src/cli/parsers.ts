import type { Rect } from '@endfield-noclip/package-format/values';

import { object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { map, multiple, optional } from '@optique/core/modifiers';
import type { NonEmptyString } from '@optique/core/nonempty';
import { argument, option } from '@optique/core/primitives';
import { integer, regExp, string, type ValueParser } from '@optique/core/valueparser';

import { parseWhere, type WherePredicate } from './query.ts';

/**
 * parses a `x,y,z` comma-separated 3D vector
 *
 * @param metavar placeholder label shown in usage text
 * @returns value parser yielding `[x, y, z]`
 */
export const vec3 = (metavar: NonEmptyString = 'X,Y,Z'): ValueParser<'sync', [number, number, number]> => ({
	mode: 'sync',
	metavar,
	placeholder: [0, 0, 0],
	parse(input) {
		const parts = input.split(',');
		if (parts.length !== 3) {
			return { success: false, error: message`expected 3 comma-separated numbers, got ${input}` };
		}
		const nums = parts.map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
		if (nums.some((n) => !Number.isFinite(n))) {
			return { success: false, error: message`expected 3 finite numbers, got ${input}` };
		}
		return { success: true, value: [nums[0], nums[1], nums[2]] };
	},
	format([x, y, z]) {
		return `${x},${y},${z}`;
	},
});

/**
 * parses a `xmin,xmax,zmin,zmax` world rectangle with `min < max`
 *
 * @param metavar placeholder label shown in usage text
 * @returns value parser yielding a {@link Rect}
 */
export const bounds = (metavar: NonEmptyString = 'XMIN,XMAX,ZMIN,ZMAX'): ValueParser<'sync', Rect> => ({
	mode: 'sync',
	metavar,
	placeholder: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
	parse(input) {
		const parts = input.split(',');
		if (parts.length !== 4) {
			return { success: false, error: message`expected 4 comma-separated numbers, got ${input}` };
		}
		const nums = parts.map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
		if (nums.some((n) => !Number.isFinite(n))) {
			return { success: false, error: message`expected 4 finite numbers, got ${input}` };
		}
		const [minX, maxX, minZ, maxZ] = nums;
		if (minX >= maxX || minZ >= maxZ) {
			return { success: false, error: message`expected xmin,xmax,zmin,zmax with min < max, got ${input}` };
		}
		return { success: true, value: { minX, minZ, maxX, maxZ } };
	},
	format({ minX, maxX, minZ, maxZ }) {
		return `${minX},${maxX},${minZ},${maxZ}`;
	},
});

/**
 * parses one `--where` dot-path predicate expression
 *
 * @returns value parser yielding a compiled {@link WherePredicate}
 */
export const wherePredicate = (): ValueParser<'sync', WherePredicate> => ({
	mode: 'sync',
	metavar: 'EXPR',
	placeholder: { op: 'truthy', path: '', raw: '' },
	parse(input) {
		try {
			return { success: true, value: parseWhere(input) };
		} catch (error) {
			return {
				success: false,
				error: message`${error instanceof Error ? error.message : String(error)}`,
			};
		}
	},
	format(value) {
		switch (value.op) {
			case 'truthy': {
				return value.path;
			}
			case 'falsy': {
				return `!${value.path}`;
			}
			default: {
				return `${value.path}${value.op}${value.raw}`;
			}
		}
	},
});

/**
 * wraps an item {@link ValueParser} to accept a comma-separated list of items (trimming whitespace and
 * skipping empty entries for string items)
 *
 * @param item item value parser
 * @param metavar placeholder label shown in usage text
 * @returns value parser yielding an array of parsed items
 */
export const csvList = <T>(
	item: ValueParser<'sync', T>,
	metavar: NonEmptyString = `${item.metavar},…`,
): ValueParser<'sync', readonly T[]> => ({
	mode: 'sync',
	metavar,
	placeholder: [],
	parse(input) {
		const parts = input
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			return { success: false, error: message`expected at least one value` };
		}
		const out: T[] = [];
		for (const part of parts) {
			const res = item.parse(part);
			if (!res.success) {
				return res;
			}
			out.push(res.value);
		}
		return { success: true, value: out };
	},
	format(values) {
		return values.map((v) => item.format(v)).join(',');
	},
});

/**
 * creates a repeatable, comma-separated option parser (e.g. `--pick a,b --pick c`) that flattens into one
 * array
 *
 * @param name option flag name
 * @param item item value parser
 * @param options optional description and metavar override
 * @returns flattened array parser
 */
export const repeatableCsvOption = <T>(
	name: `--${string}`,
	item: ValueParser<'sync', T>,
	options?: { description?: ReturnType<typeof message>; metavar?: NonEmptyString },
) => {
	return map(
		multiple(
			option(name, csvList(item, options?.metavar), {
				description: options?.description,
			}),
		),
		(groups) => groups.flat(),
	);
};

/**
 * case-insensitive regular expression value parser
 *
 * @param metavar placeholder label shown in usage text
 * @returns value parser yielding a case-insensitive `RegExp`
 */
export const ciRegExp = (metavar: NonEmptyString = 'RE') => {
	return regExp({ flags: 'i', metavar });
};

/** shared `--config <file>` option for commands that read the local install */
export const configOption = object({
	config: optional(
		option('--config', string({ metavar: 'FILE' }), {
			description: message`local config file (default endfield.local.json)`,
		}),
	),
});

/** shared `--where` repeatable filter option */
export const whereOption = multiple(
	option('--where', wherePredicate(), {
		description: message`filter by dot-path (path=val, !=, ~, !~, >, >=, <, <=, path, !path)`,
	}),
);

/** shared `--pick` repeatable/comma-separated field projection option */
export const pickOption = repeatableCsvOption('--pick', string({ metavar: 'FIELD' }), {
	description: message`project selected dot-paths`,
});

/** shared `--path-id <N>` 64-bit Unity path ID option */
export const pathIdOption = optional(
	option('--path-id', integer({ type: 'bigint', metavar: 'N' }), {
		description: message`Unity object path id`,
	}),
);

/**
 * shared variadic positional target list paired with `--stdin`
 *
 * @param metavar placeholder label for positional targets
 * @returns parser yielding `{ stdin: boolean; targets: readonly string[] }`
 */
export const targetsOrStdin = (metavar: NonEmptyString = 'TARGET') => {
	return object({
		stdin: option('--stdin', { description: message`read additional targets from stdin (one per line)` }),
		targets: multiple(argument(string({ metavar }))),
	});
};
