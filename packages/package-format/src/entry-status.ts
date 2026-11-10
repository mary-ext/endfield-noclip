/**
 * how the binary tables store an entry's status. its own module for the reason the geometry table has one
 *
 * @module
 */

import { PackageFormatError } from './errors.ts';

/** an entry's status as a binary table stores it */
export const EntryStatus = {
	Ready: 0,
	Pending: 1,
	Failed: 2,
} as const;

export type EntryStatus = (typeof EntryStatus)[keyof typeof EntryStatus];

/** the status names entries carry once decoded */
export type EntryStatusName = 'ready' | 'pending' | 'failed';

const NAMES: readonly EntryStatusName[] = ['ready', 'pending', 'failed'];

/**
 * @param name an entry's status
 * @returns its binary code
 */
export const entryStatusCode = (name: EntryStatusName): EntryStatus => {
	switch (name) {
		case 'ready': {
			return EntryStatus.Ready;
		}
		case 'pending': {
			return EntryStatus.Pending;
		}
		case 'failed': {
			return EntryStatus.Failed;
		}
	}
};

/**
 * @param code a stored status
 * @param label what the entry is, for the error
 * @returns its name
 * @throws {PackageFormatError} on an unknown code
 */
export const entryStatusName = (code: number, label: string): EntryStatusName => {
	const name = NAMES[code];
	if (name === undefined) {
		throw new PackageFormatError(`${label} has unknown status ${code}`);
	}
	return name;
};
