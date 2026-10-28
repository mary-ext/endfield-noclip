/**
 * runs `work` over `items` with bounded concurrency and hands results to `settle` strictly in item order. a
 * failed item's error is passed to `settle` instead of a result
 *
 * @param items inputs
 * @param concurrency items in flight at once, including ones finished but not yet settled
 * @param work async work per item
 * @param settle called once per item, in order; may be async, and the next settle waits for it
 */
export const orderedPool = async <T, R>(
	items: readonly T[],
	concurrency: number,
	work: (item: T, index: number) => Promise<R>,
	settle: (result: R | Error, item: T, index: number) => void | Promise<void>,
): Promise<void> => {
	const running = new Map<number, Promise<R | Error>>();
	const start = (index: number): void => {
		running.set(
			index,
			work(items[index], index).catch((error: unknown) =>
				error instanceof Error ? error : new Error(String(error)),
			),
		);
	};
	for (let index = 0; index < Math.min(concurrency, items.length); index++) {
		start(index);
	}
	for (let index = 0; index < items.length; index++) {
		// oxlint-disable-next-line no-await-in-loop -- results are settled in order
		const result = await running.get(index)!;
		running.delete(index);
		if (index + concurrency < items.length) {
			start(index + concurrency);
		}
		// oxlint-disable-next-line no-await-in-loop -- settling is sequential by contract
		await settle(result, items[index], index);
	}
};

/**
 * maps `items` with bounded concurrency
 *
 * @param items inputs
 * @param concurrency items in flight at once
 * @param work async work per item
 * @returns results in item order
 * @throws the first failure, in item order
 */
export const mapPool = async <T, R>(
	items: readonly T[],
	concurrency: number,
	work: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
	const results: R[] = [];
	let failure: Error | undefined;
	await orderedPool(items, concurrency, work, (result) => {
		if (result instanceof Error) {
			failure ??= result;
		} else {
			results.push(result);
		}
	});
	if (failure !== undefined) {
		throw failure;
	}
	return results;
};
