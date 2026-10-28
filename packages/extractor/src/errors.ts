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
