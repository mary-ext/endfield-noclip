#!/usr/bin/env node
import { readdir } from 'node:fs/promises';

/**
 * each file in `commands/` is one subcommand exporting `summary` and `run(args)`, so commands can be added
 * without touching this dispatcher.
 */
interface CommandModule {
	summary: string;
	run(args: string[]): Promise<void>;
}

const COMMANDS_DIR = new URL('./commands/', import.meta.url);

const listCommands = async (): Promise<string[]> => {
	const files = await readdir(COMMANDS_DIR);
	return files
		.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
		.map((file) => file.slice(0, -3))
		.toSorted();
};

const loadCommand = async (name: string): Promise<CommandModule> => {
	const module: unknown = await import(new URL(`${name}.ts`, COMMANDS_DIR).href);
	if (!isCommandModule(module)) {
		throw new Error(`commands/${name}.ts must export \`summary\` and \`run\``);
	}
	return module;
};

const isCommandModule = (value: unknown): value is CommandModule => {
	return (
		typeof value === 'object' &&
		value !== null &&
		'summary' in value &&
		typeof value.summary === 'string' &&
		'run' in value &&
		typeof value.run === 'function'
	);
};

// exit quietly when piped into `head` and the like
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code === 'EPIPE') {
		process.exit(0);
	}
	throw error;
});

const main = async ([command, ...args]: string[]): Promise<void> => {
	const names = await listCommands();
	if (command === undefined || command === '-h' || command === '--help') {
		const lines = await Promise.all(
			names.map(async (name) => `  ${name.padEnd(12)} ${(await loadCommand(name)).summary}`),
		);
		console.log(`usage: endfield-extract <command> [args]\n\ncommands:\n${lines.join('\n')}`);
		return;
	}
	if (!names.includes(command)) {
		throw new Error(`unknown command ${command}; run with --help`);
	}
	await (await loadCommand(command)).run(args);
};

try {
	await main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exitCode = 1;
}
