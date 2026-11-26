import { resolveEnvironment, type EnvironmentSections } from '@endfield-noclip/package-format/environment';

import { PackedPackage } from '../../../pipeline/read-package.ts';

import type { AuditSubArgs } from './parser.ts';
import { packageDirsOf, readDebugJson } from './shared.ts';

/**
 * runs `endfield-extract audit env`
 *
 * @param args parsed CLI arguments
 */
export const runAuditEnv = async (args: AuditSubArgs<'env'>): Promise<void> => {
	const { packageDir, debugDir } = packageDirsOf(args.scene, args.dir);
	await auditEnv(packageDir, debugDir, {
		phase: args.phase,
		post: args.post,
		section: args.section,
		packed: args.packed,
		json: args.json,
	});
};

interface DebugEnvFile {
	levels: {
		level: string;
		volume: string | null;
		covered: number;
		shown: number;
		phase: string | null;
		post: string | null;
		error: string | null;
	}[];
	problems: { kind: string; volume: string; reason: string }[];
}

const auditEnv = async (
	packageDir: string,
	debugDir: string,
	options: {
		phase: RegExp | undefined;
		post: RegExp | undefined;
		section: RegExp | undefined;
		packed: boolean;
		json: boolean;
	},
): Promise<void> => {
	if (
		options.phase !== undefined ||
		options.post !== undefined ||
		options.section !== undefined ||
		options.packed
	) {
		await using pkg = await PackedPackage.open(packageDir);
		const env = resolveEnvironment(await pkg.environment());
		const phases =
			options.post !== undefined && options.phase === undefined && options.section === undefined
				? []
				: env.phases
						.map((phase, index) => {
							const sections =
								options.section === undefined
									? phase.sections
									: (Object.fromEntries(
											Object.entries(phase.sections).filter(([key]) => options.section!.test(key)),
										) as Partial<EnvironmentSections>);
							return { index, name: phase.name, active: phase.active, sections };
						})
						.filter((p) => options.phase === undefined || options.phase.test(p.name));
		const posts =
			options.phase !== undefined && options.post === undefined
				? []
				: env.posts
						.map((post, index) => ({ index, name: post.name, profile: post }))
						.filter((p) => options.post === undefined || options.post.test(p.name));
		if (options.json) {
			console.log(JSON.stringify({ phases, posts }, null, '\t'));
			return;
		}
		if (options.phase === undefined && options.section === undefined && options.post === undefined) {
			console.log(`phases (${phases.length}):`);
			for (const p of phases) {
				console.log(`  ${String(p.index).padStart(3)}  ${p.name.padEnd(40)} active=${p.active.join(',')}`);
			}
			console.log(`\nposts (${posts.length}):`);
			for (const p of posts) {
				console.log(`  ${String(p.index).padStart(3)}  ${p.name}`);
			}
			return;
		}
		for (const p of phases) {
			console.log(`=== phase #${p.index}: ${p.name} (active: ${p.active.join(', ')}) ===`);
			console.log(JSON.stringify(p.sections, null, '\t'));
		}
		for (const p of posts) {
			console.log(`=== post #${p.index}: ${p.name} ===`);
			console.log(JSON.stringify(p.profile, null, '\t'));
		}
		return;
	}

	const data = await readDebugJson<DebugEnvFile>(debugDir, 'environments.json');
	if (options.json) {
		console.log(JSON.stringify(data, null, '\t'));
		return;
	}
	console.log(`levels (${data.levels.length}):`);
	for (const level of data.levels) {
		const cov = `${(level.covered * 100).toFixed(0)}%`;
		const err = level.error === null ? '' : `  ERROR: ${level.error}`;
		console.log(
			`  ${level.level.padEnd(14)} ${cov.padStart(4)}  phase=${(level.phase ?? '-').padEnd(34)} post=${level.post ?? '-'}${err}`,
		);
	}
	if (data.problems.length > 0) {
		console.log(`\nproblems (${data.problems.length}):`);
		for (const p of data.problems) {
			console.log(`  [${p.kind}] ${p.volume}: ${p.reason}`);
		}
	}
};

// #endregion
