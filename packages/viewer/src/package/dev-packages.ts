/**
 * where the dev and preview servers list and serve locally extracted packages (see
 * `vite-plugins/package-server.ts`).
 *
 * @module
 */

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
