/**
 * @param map a map the caller owns
 * @param key the key
 * @param create makes the value on first use
 * @returns the value under `key`, inserting `create()` if absent
 */
export const getOrInsert = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
	let value = map.get(key);
	if (value === undefined) {
		value = create();
		map.set(key, value);
	}
	return value;
};

/**
 * interns values by key into a list
 *
 * @param list the list the caller owns; new values are appended
 * @param index the list's index by key, kept in step with it
 * @param key the value's key
 * @param create makes the value on first use
 * @returns the value's position in `list`
 */
export const intern = <K, V>(list: V[], index: Map<K, number>, key: K, create: () => V): number =>
	getOrInsert(index, key, () => list.push(create()) - 1);
