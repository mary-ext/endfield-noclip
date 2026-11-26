/**
 * where the dev and preview servers list and serve locally extracted packages (see
 * `vite-plugins/package-server.ts`).
 *
 * @module
 */

import { type PackageSource, httpSource } from './package-source.ts';

/** URL prefix the packages are served under; package `name` lives at `${DEV_PACKAGES_PREFIX}${name}/` */
export const DEV_PACKAGES_PREFIX = '/packages/';

/** path under {@link DEV_PACKAGES_PREFIX} of the package list */
export const DEV_PACKAGES_INDEX = 'index.json';

/** an entry of the package list */
export interface DevPackage {
	name: string;
	/** byte length of the package's core archive */
	coreSize: number;
}

/**
 * @returns the packages the dev or preview server lists; none where the page isn't served by one (the index
 *   is missing or isn't JSON)
 * @throws when the request fails or the body isn't valid JSON
 */
export const fetchDevPackages = async (): Promise<DevPackage[]> => {
	const response = await fetch(`${DEV_PACKAGES_PREFIX}${DEV_PACKAGES_INDEX}`);
	if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
		return [];
	}
	const body: unknown = await response.json();
	if (typeof body !== 'object' || body === null || !('packages' in body) || !Array.isArray(body.packages)) {
		return [];
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own dev endpoint
	return body.packages as DevPackage[];
};

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
