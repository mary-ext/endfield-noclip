import { ruleText } from '@endfield-noclip/package-format/conditions';

import { mapDefined } from '@mary-ext/array-fns';

import { GameState } from '../../../game/state/game-state.ts';
import {
	defaultSceneStates,
	loadMapVariables,
	loadSceneStates,
	sceneStateControl,
} from '../../../game/state/scene-conditions.ts';
import { loadSceneryVariants } from '../../../game/state/scenery-variants.ts';
import { loadUpgradeLinks } from '../../../game/state/settlement-upgrades.ts';
import { type Context, withContext } from '../../../install/context.ts';

import type { SceneSubArgs } from './parser.ts';

/**
 * runs `endfield-extract scene controls`
 *
 * @param args parsed CLI arguments
 */
export const runSceneControls = async (args: SceneSubArgs<'controls'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		await showControls(context, args.scene, args.json);
	});
};

const showControls = async (context: Context, scene: string, json: boolean): Promise<void> => {
	const { world } = context;
	const [variants, states, links, variables] = await Promise.all([
		loadSceneryVariants(world, scene),
		loadSceneStates(world, scene),
		loadUpgradeLinks(context, scene),
		loadMapVariables(world, scene),
	]);
	const game = new GameState({ links, variables });
	game.note(mapDefined(states, ({ condition }) => condition ?? undefined));
	const enabled = defaultSceneStates(states, game);
	if (json) {
		console.log(
			JSON.stringify(
				{
					...variants,
					sceneStates: states.map(({ index, name, condition }) => ({
						control: sceneStateControl(index),
						name,
						defaultOn: enabled.has(index),
						rule: condition === null ? null : ruleText(game.describe(condition)),
					})),
				},
				null,
				'\t',
			),
		);
		return;
	}
	if (states.length > 0) {
		console.log(`${scene}: ${states.length} scene states`);
		for (const { index, name, condition } of states) {
			console.log(
				`  ${enabled.has(index) ? 'on ' : 'off'} ${sceneStateControl(index).padEnd(14)} ${name}: ${
					condition === null ? 'only set by name' : ruleText(game.describe(condition))
				}`,
			);
		}
		console.log();
	}
	console.log(`${variants.scene}: ${variants.areas.length} stream areas with static chunks`);
	console.log('        area  root  shown inside zones            files  entities  level');
	for (const area of variants.areas) {
		const inside = area.shownInside.join(',') || '-';
		console.log(
			`${String(area.id).padStart(12)}  ${area.rootVisible ? 'yes ' : '    '}  ${inside.padEnd(30)} ${String(area.chunkFiles).padStart(5)}  ${String(area.entities).padStart(8)}  ${area.levelId ?? '-'} ${area.levelName ?? ''}`,
		);
	}
	console.log(
		`\n${variants.progressions.length} progression controllers (DynamicStreaming LogicState levels)`,
	);
	console.log(
		'kind           key                            level                         levels (groups)       default',
	);
	for (const p of variants.progressions) {
		const levels = p.levels.map((level) => `${level}(${p.groupsPerLevel[level]})`).join(' ');
		console.log(
			`${p.kind.padEnd(14)} ${p.key.padEnd(30)} ${`${p.levelId ?? '-'} ${p.levelName ?? ''}`.padEnd(29)} ${levels.padEnd(21)} ${p.defaultLevel}`,
		);
	}
};

// #endregion
