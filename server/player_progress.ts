// Player progress persistence: saves a player's stats (health, armor,
// ammo, weapons/items, current weapon) to Deno KV keyed by their
// authenticated username, and restores them on their next spawn -- in this
// room or any other, since it's keyed globally per-account rather than
// per-room (rooms are ephemeral; a player's progress isn't).
//
// Wired up via src/progress_hooks.js so the shared engine code
// (host_cmd.js, sv_main.js) never imports Deno-specific KV code directly.

import { Host_SetProgressHooks } from '../src/progress_hooks.js';

// Same pinned-path trick as auth.ts: Deno.openKv() with no path resolves
// relative to whichever deno.json gets discovered for the entry script,
// which differs depending on how/where a process is launched from.
const kvPath = decodeURIComponent( new URL( './data/progress.db', import.meta.url ).pathname )
	.replace( /^\/([A-Za-z]:)/, '$1' );
await Deno.mkdir( new URL( './data', import.meta.url ), { recursive: true } );
const kv = await Deno.openKv( kvPath );

interface PlayerStats {
	health: number;
	armorvalue: number;
	armortype: number;
	ammo_shells: number;
	ammo_nails: number;
	ammo_rockets: number;
	ammo_cells: number;
	items: number;
	weapon: number;
	currentammo: number;
	savedAt: number;
}

// deno-lint-ignore no-explicit-any
type Edict = any; // pr_edict.js's edict_t -- not worth typing fully here

function readStats( ent: Edict ): PlayerStats {

	return {
		health: ent.v.health,
		armorvalue: ent.v.armorvalue,
		armortype: ent.v.armortype,
		ammo_shells: ent.v.ammo_shells,
		ammo_nails: ent.v.ammo_nails,
		ammo_rockets: ent.v.ammo_rockets,
		ammo_cells: ent.v.ammo_cells,
		items: ent.v.items,
		weapon: ent.v.weapon,
		currentammo: ent.v.currentammo,
		savedAt: Date.now(),
	};

}

function applyStats( ent: Edict, stats: PlayerStats ): void {

	ent.v.health = stats.health;
	ent.v.armorvalue = stats.armorvalue;
	ent.v.armortype = stats.armortype;
	ent.v.ammo_shells = stats.ammo_shells;
	ent.v.ammo_nails = stats.ammo_nails;
	ent.v.ammo_rockets = stats.ammo_rockets;
	ent.v.ammo_cells = stats.ammo_cells;
	ent.v.items = stats.items;
	ent.v.weapon = stats.weapon;
	ent.v.currentammo = stats.currentammo;

}

function keyFor( username: string ) {

	return [ 'progress', username.toLowerCase() ];

}

export async function loadPlayerProgress( username: string ): Promise<PlayerStats | null> {

	if ( ! username ) return null;
	const entry = await kv.get<PlayerStats>( keyFor( username ) );
	return entry.value;

}

export async function savePlayerProgress( username: string, ent: Edict ): Promise<void> {

	if ( ! username ) return;

	// A player who left dead shouldn't come back dead -- let them respawn
	// fresh instead of stuck at 0/negative health with no way to act.
	if ( ent.v.health <= 0 ) return;

	await kv.set( keyFor( username ), readStats( ent ) );

}

/**
 * Best-effort periodic save for all currently spawned players, in case the
 * process dies without a clean disconnect (crash, SIGKILL, power loss) --
 * call this from the room's existing heartbeat interval. clients is
 * svs.clients; maxclients is svs.maxclients.
 */
export function autosaveActivePlayers( clients: Edict[], maxclients: number ): void {

	for ( let i = 0; i < maxclients; i ++ ) {

		const client = clients[ i ];
		if ( client == null || ! client.active || ! client.spawned || client.edict == null ) continue;
		savePlayerProgress( client.name, client.edict ).catch( () => { /* best-effort */ } );

	}

}

/**
 * Call once per room process to wire progress persistence into the shared
 * engine's spawn/disconnect hooks.
 */
export function PlayerProgress_Init(): void {

	Host_SetProgressHooks( {
		onSpawn: ( username: string, ent: Edict ) => {

			loadPlayerProgress( username ).then( ( stats ) => {

				if ( stats == null ) return;
				applyStats( ent, stats );

			} ).catch( () => { /* no saved progress, or a transient KV error -- spawn with defaults */ } );

		},
		onDisconnect: ( username: string, ent: Edict ) => {

			savePlayerProgress( username, ent ).catch( () => { /* best-effort */ } );

		},
	} );

}
