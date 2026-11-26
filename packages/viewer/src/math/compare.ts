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
