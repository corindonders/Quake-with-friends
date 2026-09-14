// Shared hub definitions: which map the hub room runs, and the game-mode
// config the in-world kiosk (src/hub_kiosk.js) sends to the lobby when a
// player starts a match. Imported by both the browser client and the Deno
// lobby (server/lobby_server.js), so it must stay dependency-free.
//
// HUB_MAP is the one place the hub's world is chosen. It's still not the
// purpose-built "skybox + floor + kiosk" level the design calls for -- this
// repo ships map *sources* (.map) but no compiler tooling (no qbsp/light/vis
// binaries), so a new minimal .bsp can't be authored here -- but per v1 build
// order item 6, it's now a deliberately chosen existing map rather than a
// placeholder: the Q30 Deathmatch Jam pack's own map-select hub (see
// mapdb.json's "q30__start" entry), a single open rotunda with real floor
// space around its one info_player_start, no monsters. Once a real
// purpose-built hub .bsp exists, dropping it in maps/ and changing HUB_MAP
// (plus HUB_MOD, if it needs no mod) is the whole swap.

export const HUB_ROOM_ID = 'HUBWLD';
export const HUB_MAP = 'q30__start';
export const HUB_MOD = 'mods/copper';
export const HUB_MAX_PLAYERS = 16;

// Distance, in Quake units, from the kiosk at which the "press E" prompt
// appears. Roughly two player widths.
export const HUB_KIOSK_RANGE = 96;

// Where the kiosk trigger box and its panel sit, and which direction the
// panel faces -- fixed world coordinates in HUB_MAP, not derived from the
// map's info_player_start at runtime (that regex-based approach is what
// this replaces, see git history on hub_kiosk.js/worldspace_ui.js). Chosen
// by hand: q30__start's info_player_start sits at (-64, 472, 152) facing
// south (angle 270); these sit ~1-1.5 player-widths west of it, off to the
// side of the main path into the rotunda rather than blocking it, on
// flat confirmed-solid floor (checked in-engine, well short of the lava
// ringing the platform's east and south edges).
export const HUB_KIOSK_POSITION = [ -136, 472, 152 ];
export const HUB_KIOSK_PANEL_POSITION = [ -164, 472, 192 ];
export const HUB_KIOSK_PANEL_FACING = [ -64, 472, 192 ];

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
