import { DEV_PACKAGES_PREFIX } from '../package/dev-packages.ts';
import { type PackageSource, httpSource } from '../package/package-source.ts';

/**
 * @param value a `?package=` value: a dev package name, or a URL/path of a package directory
 * @returns a source for it
 */
export const sourceFromParam = (value: string): PackageSource => {
	if (/^(https?:)?\/|^\.\.?\//.test(value)) {
		return httpSource(value);
	}
	return httpSource(`${DEV_PACKAGES_PREFIX}${encodeURIComponent(value)}/`);
};
