/**
 * Catalog of avatar presets users can pick from. The exact same list
 * ships in the frontend so both sides agree on what IDs are valid.
 *
 * We delegate the actual illustration to DiceBear (micah style) — the
 * URL is deterministic from the seed, so once an ID lands in a user's
 * profile the avatar never drifts.
 */
export type AvatarGender = 'male' | 'female';

export interface AvatarPreset {
	id: string;
	seed: string;
	gender: AvatarGender;
}

export const AVATAR_PRESETS: AvatarPreset[] = [
	// ─── Male (20) ────────────────────────────────────────────────
	// European
	{ id: 'm1', seed: 'Oliver', gender: 'male' },
	{ id: 'm2', seed: 'Lars', gender: 'male' },
	{ id: 'm3', seed: 'Dmitri', gender: 'male' },
	{ id: 'm4', seed: 'Mikhail', gender: 'male' },
	// East Asian
	{ id: 'm5', seed: 'Kenji', gender: 'male' },
	{ id: 'm6', seed: 'Minho', gender: 'male' },
	{ id: 'm7', seed: 'WeiChen', gender: 'male' },
	{ id: 'm8', seed: 'HiroshiTan', gender: 'male' },
	// South Asian
	{ id: 'm9', seed: 'ArjunPatel', gender: 'male' },
	{ id: 'm10', seed: 'RajeshKumar', gender: 'male' },
	// Middle Eastern
	{ id: 'm11', seed: 'OmarHassan', gender: 'male' },
	{ id: 'm12', seed: 'YoussefAmir', gender: 'male' },
	// African
	{ id: 'm13', seed: 'KwameAdjei', gender: 'male' },
	{ id: 'm14', seed: 'JabariOkafor', gender: 'male' },
	{ id: 'm15', seed: 'TundeAyoola', gender: 'male' },
	// Latin
	{ id: 'm16', seed: 'DiegoMoreno', gender: 'male' },
	{ id: 'm17', seed: 'MateoRivera', gender: 'male' },
	{ id: 'm18', seed: 'RafaelCruz', gender: 'male' },
	// Pacific / Indigenous
	{ id: 'm19', seed: 'TaneMoana', gender: 'male' },
	{ id: 'm20', seed: 'KaiNoa', gender: 'male' },

	// ─── Female (20) ──────────────────────────────────────────────
	// European
	{ id: 'f1', seed: 'EmmaSvensson', gender: 'female' },
	{ id: 'f2', seed: 'ZofiaKowalska', gender: 'female' },
	{ id: 'f3', seed: 'ElenaRossi', gender: 'female' },
	{ id: 'f4', seed: 'FrejaIngrid', gender: 'female' },
	// East Asian
	{ id: 'f5', seed: 'MeiLin', gender: 'female' },
	{ id: 'f6', seed: 'YukiTanaka', gender: 'female' },
	{ id: 'f7', seed: 'HyunjiPark', gender: 'female' },
	{ id: 'f8', seed: 'ThaoNguyen', gender: 'female' },
	// South Asian
	{ id: 'f9', seed: 'PriyaSharma', gender: 'female' },
	{ id: 'f10', seed: 'AnikaDesai', gender: 'female' },
	// Middle Eastern
	{ id: 'f11', seed: 'LaylaKarim', gender: 'female' },
	{ id: 'f12', seed: 'YasminAmira', gender: 'female' },
	// African
	{ id: 'f13', seed: 'AmaraNia', gender: 'female' },
	{ id: 'f14', seed: 'ZuriImani', gender: 'female' },
	{ id: 'f15', seed: 'KelechiAdaora', gender: 'female' },
	// Latin
	{ id: 'f16', seed: 'CamilaSofia', gender: 'female' },
	{ id: 'f17', seed: 'IsabelaLucia', gender: 'female' },
	{ id: 'f18', seed: 'ValentinaRose', gender: 'female' },
	// Pacific / Indigenous
	{ id: 'f19', seed: 'MoanaKaleaIna', gender: 'female' },
	{ id: 'f20', seed: 'ArohaHinemoa', gender: 'female' },
];

export const AVATAR_STYLE = 'avataaars';

/**
 * DiceBear 'micah' doesn't take a gender param, so male seeds often
 * render as female and vice versa. We swap to 'avataaars' and lock
 * the hair/top pool per gender — short-hair variants for male,
 * long-hair variants for female, with facial hair gated accordingly.
 * The seed still drives all the other randomness (skin tone, clothes,
 * accessories, mouth) so each preset is unique.
 */
const MALE_TOP_POOL = [
	'shortCurly',
	'shortFlat',
	'shortRound',
	'shortWaved',
	'sides',
	'theCaesar',
	'theCaesarAndSidePart',
	'dreads01',
	'dreads02',
	'frizzle',
];

const FEMALE_TOP_POOL = [
	'bigHair',
	'bob',
	'bun',
	'curly',
	'curvy',
	'dreads',
	'frida',
	'fro',
	'froBand',
	'longButNotTooLong',
	'miaWallace',
	'straight01',
	'straight02',
	'straightAndStrand',
];

export const avatarUrlFor = (preset: AvatarPreset): string => {
	// DiceBear v9 avataaars accepts comma-separated option lists, but
	// URLSearchParams would percent-encode the commas. We build the
	// query string manually to keep bare commas in the URL.
	const parts: string[] = [`seed=${encodeURIComponent(preset.seed)}`];
	if (preset.gender === 'male') {
		parts.push(`top=${MALE_TOP_POOL.join(',')}`);
	} else {
		parts.push(`top=${FEMALE_TOP_POOL.join(',')}`);
		parts.push('facialHairProbability=0');
	}
	return `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?${parts.join('&')}`;
};

export const findPreset = (id: string): AvatarPreset | undefined =>
	AVATAR_PRESETS.find((p) => p.id === id);
