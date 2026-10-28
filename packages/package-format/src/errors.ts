/** thrown when package data doesn't match the expected layout */
export class PackageFormatError extends Error {
	override name = 'PackageFormatError';
}
