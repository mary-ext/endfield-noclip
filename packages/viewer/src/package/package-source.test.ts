import assert from 'node:assert/strict';
import { it } from 'node:test';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/format';

import { fileListSource, PackageChangedError } from './package-source.ts';

/** a file as a directory input lists it (Node's `File` has no `webkitRelativePath`) */
const picked = (bytes: Uint8Array<ArrayBuffer>, name: string): File =>
	Object.defineProperty(new File([bytes], name), 'webkitRelativePath', { value: `package/${name}` });

it('refuses range reads from an archive whose size no longer matches the manifest', async () => {
	const source = fileListSource([
		picked(new Uint8Array(4), CORE_ARCHIVE),
		picked(new Uint8Array([1, 2, 3, 4, 5, 6]), 'shard.czar'),
	]);
	assert.deepEqual(
		await source.readRange('shard.czar', { offset: 2, length: 3, fileSize: 6 }),
		new Uint8Array([3, 4, 5]),
	);
	await assert.rejects(
		source.readRange('shard.czar', { offset: 2, length: 3, fileSize: 8 }),
		PackageChangedError,
	);
});
