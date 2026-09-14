// Shared hub definitions: which map the hub room runs, and the game-mode
// config the in-world kiosk (src/hub_kiosk.js) sends to the lobby when a
// player starts a match. Imported by both the browser client and the Deno
// lobby (server/lobby_server.js), so it must stay dependency-free.
//
// HUB_MAP is the one place the hub's world is chosen. It is still Copper's
// own "start" map rather than the purpose-built "skybox + floor + kiosk"
// level the design calls for: this repo ships map *sources* (.map) but no
// compiler tooling (no qbsp/light/vis binaries), so a new minimal .bsp
// can't be built here and hand-authoring a .bsp binary isn't reasonable.
// Once a real hub .bsp exists, dropping it in maps/ and changing HUB_MAP
// (plus HUB_MOD, if it needs no mod) is the whole swap.

export const HUB_ROOM_ID = 'HUBWLD';
export const HUB_MAP = 'start';
export const HUB_MOD = 'mods/copper';
export const HUB_MAX_PLAYERS = 16;

// Distance, in Quake units, from the kiosk at which the "press E" prompt
// appears. Roughly two player widths.
export const HUB_KIOSK_RANGE = 96;

// Where the kiosk stands. Since the hub map isn't purpose-built (see above)
// there's no kiosk entity in it, so the client derives the spot at runtime:
// the map's info_player_start, pushed this far along the direction that
// spawn faces -- open space by construction, whatever map HUB_MAP names.
export const HUB_KIOSK_SPAWN_OFFSET = 72;

export const HUB_MODES = [ 'ffa', 'teams', 'teams_ai', 'coop', 'horde' ];

export const HUB_MODE_TITLES = {
	ffa: 'Free-for-all',
	teams: 'Team vs Team',
	teams_ai: 'Team vs AI',
	coop: 'Co-op',
	horde: 'Horde',
};

export const HUB_MAX_TEAMS = 4;

/**
 * Clamp an untrusted mode config (it arrives over the wire) into the
 * canonical { mapId, mode, teamCount, maxPlayers } shape.
 */
export function Hub_NormalizeModeConfig( config ) {

	const raw = config || {};

	const mapId = String( raw.mapId || '' ).toLowerCase().replace( /[^a-z0-9_]/g, '' );
	const mode = HUB_MODES.includes( raw.mode ) ? raw.mode : 'ffa';

	let teamCount = parseInt( raw.teamCount, 10 );
	if ( isNaN( teamCount ) ) teamCount = 2;
	if ( teamCount < 2 ) teamCount = 2;
	if ( teamCount > HUB_MAX_TEAMS ) teamCount = HUB_MAX_TEAMS;
	if ( mode !== 'teams' && mode !== 'teams_ai' ) teamCount = 0;

	let maxPlayers = parseInt( raw.maxPlayers, 10 );
	if ( isNaN( maxPlayers ) ) maxPlayers = HUB_MAX_PLAYERS;
	if ( maxPlayers < 1 ) maxPlayers = 1;
	if ( maxPlayers > HUB_MAX_PLAYERS ) maxPlayers = HUB_MAX_PLAYERS;

	return { mapId, mode, teamCount, maxPlayers };

}

/**
 * Deterministic 6-char room ID for a normalized mode config. Same shape as
 * travel_ui.js's roomIdForMap (fixed 'W' prefix, Quake-safe alphabet), but
 * hashing the mode too, so "frogsbog in co-op" and "frogsbog free-for-all"
 * are two different rooms instead of one contested one.
 */
export function Hub_RoomIdForConfig( config ) {

	const normalized = Hub_NormalizeModeConfig( config );
	const source = normalized.mapId + '|' + normalized.mode + '|' + normalized.teamCount;

	let hash = 0;
	for ( let i = 0; i < source.length; i ++ ) {

		hash = ( hash * 31 + source.charCodeAt( i ) ) | 0;

	}

	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let id = 'W';
	let h = Math.abs( hash );
	for ( let i = 0; i < 5; i ++ ) {

		id += chars[ h % chars.length ];
		h = Math.floor( h / chars.length );

	}

	return id;

}
