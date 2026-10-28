import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { packageServer } from './vite-plugins/package-server.ts';

// packages the extractor wrote; override with NOCLIP_PACKAGES=/path/to/dir
const packagesRoot = resolve(process.env.NOCLIP_PACKAGES ?? resolve(import.meta.dirname, '../../out'));

export default defineConfig({
	plugins: [react(), packageServer(packagesRoot)],
	worker: {
		format: 'es',
	},
});
