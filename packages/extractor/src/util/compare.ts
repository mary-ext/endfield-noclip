/**
 * compares two numbers in ascending order
 *
 * @param a first number
 * @param b second number
 * @returns negative when `a < b`, zero when equal, positive when `a > b`
 */
export const compareNumbers = (a: number, b: number): number => a - b;

/**
 * compares two strings in UTF-16 code-unit order
 *
 * @param a first string
 * @param b second string
 * @returns `-1` when `a < b`, `0` when equal, `1` when `a > b`
 */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * compares two strings in UTF-16 code-unit order, ordering runs of ASCII digits by numeric value (falling
 * back to code-unit order when strings differ only in leading zeros)
 *
 * @param a first string
 * @param b second string
 * @returns negative when `a` comes before `b`, zero when equal, positive when `a` comes after `b`
 */
export const compareNatural = (a: string, b: string): number => {
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const ca = a.charCodeAt(i);
		const cb = b.charCodeAt(j);
		if (isDigit(ca) && isDigit(cb)) {
			let iEnd = i + 1;
			while (iEnd < a.length && isDigit(a.charCodeAt(iEnd))) {
				iEnd++;
			}
			let jEnd = j + 1;
			while (jEnd < b.length && isDigit(b.charCodeAt(jEnd))) {
				jEnd++;
			}
			let iNz = i;
			while (iNz < iEnd && a.charCodeAt(iNz) === 48) {
				iNz++;
			}
			let jNz = j;
			while (jNz < jEnd && b.charCodeAt(jNz) === 48) {
				jNz++;
			}
			const sigDiff = iEnd - iNz - (jEnd - jNz);
			if (sigDiff !== 0) {
				return sigDiff;
			}
			for (let k = 0; k < iEnd - iNz; k++) {
				const diff = a.charCodeAt(iNz + k) - b.charCodeAt(jNz + k);
				if (diff !== 0) {
					return diff;
				}
			}
			i = iEnd;
			j = jEnd;
		} else {
			if (ca !== cb) {
				return ca - cb;
			}
			i++;
			j++;
		}
	}
	if (i !== a.length || j !== b.length) {
		return i < a.length ? 1 : -1;
	}
	return compareStrings(a, b);
};
