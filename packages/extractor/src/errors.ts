/**
 * @param error anything thrown
 * @returns its message
 */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * @param error anything thrown
 * @returns its message with numbers, hashes and CAB names replaced by `N`, so equal failures tally together
 */
export const failureReason = (error: unknown): string => {
	return errorText(error).replaceAll(/-?\d{3,}|[0-9a-f]{24,}|CAB-[0-9a-f]+/g, 'N');
};

/**
 * @param error anything thrown
 * @returns its Node.js error code (`ENOENT`, `EEXIST`, …), if it has one
 */
export const errorCode = (error: unknown): string | undefined => {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
};

/**
 * @param operation a file system operation
 * @param fallback what to return if it failed because the file doesn't exist
 * @returns the operation's result, or `fallback` on ENOENT
 * @throws whatever else the operation threw
 */
export const ignoreMissing = async <T, F>(operation: Promise<T>, fallback: F): Promise<T | F> => {
	try {
		return await operation;
	} catch (error) {
		if (errorCode(error) === 'ENOENT') {
			return fallback;
		}
		throw error;
	}
};
