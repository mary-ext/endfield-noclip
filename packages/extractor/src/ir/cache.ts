/** a bundle a read or conversion touched, as the VFS catalog had it then */
export interface BundleSource {
	/** manifest bundle name, `main/<hex>.ab` */
	bundle: string;
	md5: string;
}

/** minimal value-memoization interface accepted by `game/` readers so they don't depend on `PackCache` */
export interface MemoCache {
	fingerprint(entry: URL): Promise<string>;
	keyWith(fingerprint: string, parts: object): string;
	stepKey(entry: URL, parts: object): Promise<string>;
	recallValue<T>(key: string): Promise<T | undefined>;
	rememberValue(key: string, value: unknown): Promise<void>;
}
