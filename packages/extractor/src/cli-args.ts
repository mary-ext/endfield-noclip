import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ParseArgsOptionsConfig } from 'node:util';

import type { Rect } from '@endfield-noclip/package-format/format';

// argument helpers shared by the commands. they live outside `commands/`, where every file is a command

/**
 * moves positionals behind `--` so negative numbers (cell coordinates, path ids) aren't parsed as short
 * options. an argument is an option when it starts with `-` and isn't a negative number; a string option's
 * separate value is kept with it
 *
 * @param args raw arguments
 * @param options the `parseArgs` options config the result is parsed with
 * @returns arguments in `[...options, '--', ...positionals]` order
 */
export const separatePositionals = (args: readonly string[], options: ParseArgsOptionsConfig): string[] => {
	const valueOptions = new Set<string>();
	for (const [name, option] of Object.entries(options)) {
		if (option.type === 'string') {
			valueOptions.add(`--${name}`);
			if (option.short !== undefined) {
				valueOptions.add(`-${option.short}`);
			}
		}
	}
	const flags: string[] = [];
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--') {
			positionals.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith('-') && !/^-\.?\d/.test(arg)) {
			flags.push(arg);
			if (valueOptions.has(arg) && i + 1 < args.length) {
				flags.push(args[++i]);
			}
		} else {
			positionals.push(arg);
		}
	}
	return [...flags, '--', ...positionals];
};

/**
 * @param text argument text
 * @param label flag or argument name, for the error
 * @returns the number
 * @throws {Error} if it isn't a finite number
 */
export const parseNumber = (text: string, label: string): number => {
	const value = text.trim() === '' ? Number.NaN : Number(text);
	if (!Number.isFinite(value)) {
		throw new Error(`${label} must be a number, got ${text}`);
	}
	return value;
};

/**
 * @param text comma-separated numbers
 * @param count how many there must be
 * @param label flag name, for the error
 * @returns the numbers
 * @throws {Error} if there aren't exactly `count` finite numbers
 */
export const parseNumbers = (text: string, count: number, label: string): number[] => {
	const values = text.split(',').map((part) => parseNumber(part, label));
	if (values.length !== count) {
		throw new Error(`${label} needs ${count} comma-separated numbers`);
	}
	return values;
};

/**
 * @param text argument text
 * @param label flag or argument name, for the error
 * @returns the integer
 * @throws {Error} if it isn't an integer
 */
export const parseInteger = (text: string, label: string): number => {
	const value = parseNumber(text, label);
	if (!Number.isInteger(value)) {
		throw new Error(`${label} must be an integer, got ${text}`);
	}
	return value;
};

/**
 * @param text an optional option's value
 * @param label flag name, for the error
 * @returns the integer, or `undefined` if the option wasn't given
 * @throws {Error} if it was given and isn't an integer
 */
export const parseOptionalInteger = (text: string | undefined, label: string): number | undefined => {
	return text === undefined ? undefined : parseInteger(text, label);
};

/**
 * @param text an optional option's value
 * @param label flag name, for the error
 * @returns the path id, or `undefined` if the option wasn't given
 * @throws {Error} if it was given and isn't an integer
 */
export const parsePathId = (text: string | undefined, label: string): bigint | undefined => {
	if (text === undefined) {
		return undefined;
	}
	if (!/^-?\d+$/.test(text)) {
		throw new Error(`${label} must be an integer, got ${text}`);
	}
	return BigInt(text);
};

/**
 * @param text a zstd level argument
 * @param label flag name, for the error
 * @returns the level
 * @throws {Error} if it isn't an integer from 1 to 22
 */
export const parseZstdLevel = (text: string, label: string): number => {
	const value = Number(text);
	if (!Number.isInteger(value) || value < 1 || value > 22) {
		throw new Error(`${label} must be an integer from 1 to 22`);
	}
	return value;
};

/**
 * @param text `xmin,xmax,zmin,zmax`
 * @returns the world rectangle
 * @throws {Error} if it isn't four numbers with min < max
 */
export const parseBounds = (text: string): Rect => {
	const [minX, maxX, minZ, maxZ] = parseNumbers(text, 4, '--bounds');
	if (minX >= maxX || minZ >= maxZ) {
		throw new Error('--bounds must be xmin,xmax,zmin,zmax with min < max');
	}
	return { minX, minZ, maxX, maxZ };
};

/**
 * writes a file, creating its directory
 *
 * @param path destination
 * @param bytes contents
 */
export const save = async (path: string, bytes: Uint8Array): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
};
