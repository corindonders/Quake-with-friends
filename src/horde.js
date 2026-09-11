// Horde/wave survival mode.
//
// Deliberately implemented entirely in JS rather than as a QuakeC change to
// a mod's progs.dat -- there's no QuakeC compiler toolchain in this repo, so
// editing mods/copper/src and recompiling isn't practical here. Instead this
// reuses the exact same spawn path Host_Summon_f (see host_cmd.js) already
// uses to place any classname from the currently loaded mod: allocate an
// edict, fill in classname/origin/angles, then run its normal QuakeC spawn
// function. That works unmodified against any mod's progs.dat, the same way
// summon does.
//
// Flow: horde_start begins wave 1 after a short delay. Horde_Think (called
// once per server frame from Host_ServerFrame) watches the wave's spawned
// entities and starts the next wave a few seconds after the last one dies.
// horde_stop ends it. State is in-memory only, per room process.

import { Cmd_AddCommand, cmd_source, src_command, Cmd_ForwardToServer } from './cmd.js';
import { sv, svs, host_client, ss_loading } from './server.js';
import { EDICT_TO_PROG, pr_global_struct, pr_functions } from './progs.js';
import { PR_ExecuteProgram } from './pr_exec.js';
import { ED_Alloc, ED_FindField, ED_FindFunction, ED_ParseEpair } from './pr_edict.js';
import { SV_BroadcastPrintf, SV_ClientPrintf } from './host.js';
import { realtime } from './host.js';
import { cvar_t, Cvar_RegisterVariable } from './cvar.js';

// All admin-tunable: a room host sets these from the in-game console (e.g.
// "sv_horde_wavedelay 8") like any other server cvar (sv_gravity, teamplay,
// ...). archive=true so a chosen difficulty persists across restarts;
// server=true so players see a confirmation print when one changes.
export const sv_horde_startdelay = new cvar_t( 'sv_horde_startdelay', '3', true, true ); // seconds before wave 1
export const sv_horde_wavedelay = new cvar_t( 'sv_horde_wavedelay', '8', true, true ); // seconds between a clear and the next wave
export const sv_horde_basecount = new cvar_t( 'sv_horde_basecount', '3', true, true ); // monsters in wave 1
export const sv_horde_growth = new cvar_t( 'sv_horde_growth', '1', true, true ); // extra monsters added per wave
export const sv_horde_maxsize = new cvar_t( 'sv_horde_maxsize', '16', true, true ); // hard cap on monsters per wave
export const sv_horde_healthgrowth = new cvar_t( 'sv_horde_healthgrowth', '0.04', true, true ); // fractional monster health increase per wave (0.04 = +4%/wave)

// Monster pool, gated by minWave so early waves stay survivable and the
// nastier vanilla monsters only show up once the group has been through a
// few rounds. Vanilla/Copper classnames only (see wiki.html's Enemies &
// Items list) -- Fantasy Quake's custom bestiary isn't covered.
const MONSTER_POOL = [
	{ name: 'monster_army', minWave: 1 },
	{ name: 'monster_dog', minWave: 1 },
	{ name: 'monster_zombie', minWave: 1 },
	{ name: 'monster_enforcer', minWave: 2 },
	{ name: 'monster_knight', minWave: 2 },
	{ name: 'monster_wizard', minWave: 3 },
	{ name: 'monster_demon1', minWave: 3 },
	{ name: 'monster_ogre', minWave: 4 },
	{ name: 'monster_hell_knight', minWave: 5 },
	{ name: 'monster_shalrath', minWave: 6 },
	{ name: 'monster_shambler', minWave: 7 }
];

let active = false;
let wave = 0;
let aliveEnts = [];
let waveTimer = 0; // realtime to spawn the next wave at, 0 = not scheduled

/*
=================
_pickSpawnOrigin

Monsters spawn scattered around a random connected, spawned player --
there's no dependency on the map having pre-placed spawn points, so this
works on any map.
=================
*/
function _pickSpawnOrigin() {

	const candidates = [];
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const c = svs.clients[ i ];
		if ( c && c.active && c.spawned ) candidates.push( c );

	}

	if ( candidates.length === 0 ) return null;
	return candidates[ Math.floor( Math.random() * candidates.length ) ].edict;

}

/*
=================
_spawnOne

Same allocate-edict-then-run-spawn-function path as Host_Summon_f.
healthMult scales the monster's health (and max_health, when the mod
tracks one separately) after its normal QuakeC spawn function has set the
base value, so later waves are tougher as well as bigger.
=================
*/
function _spawnOne( classname, originEnt, healthMult ) {

	const func = ED_FindFunction( classname );
	if ( ! func ) return null;

	const ent = ED_Alloc();

	const classField = ED_FindField( 'classname' );
	ED_ParseEpair( ent._fieldAccessor, classField, classname );

	const yaw = Math.random() * 360;
	const dist = 96 + Math.random() * 160;
	const rad = yaw * Math.PI / 180;
	const ox = originEnt.v.origin[ 0 ] + Math.cos( rad ) * dist;
	const oy = originEnt.v.origin[ 1 ] + Math.sin( rad ) * dist;
	const oz = originEnt.v.origin[ 2 ] + 32;

	const originField = ED_FindField( 'origin' );
	ED_ParseEpair( ent._fieldAccessor, originField, ox + ' ' + oy + ' ' + oz );

	const anglesField = ED_FindField( 'angles' );
	if ( anglesField ) ED_ParseEpair( ent._fieldAccessor, anglesField, '0 ' + yaw + ' 0' );

	pr_global_struct.time = sv.time;
	pr_global_struct.self = EDICT_TO_PROG( ent );

	// See Host_Summon_f for why spawn functions need sv.state === ss_loading.
	const prevState = sv.state;
	sv.state = ss_loading;
	try {

		PR_ExecuteProgram( pr_functions.indexOf( func ) );

	} finally {

		sv.state = prevState;

	}

	if ( healthMult && healthMult !== 1 && ent.v.health > 0 ) {

		ent.v.health = Math.round( ent.v.health * healthMult );
		if ( typeof ent.v.max_health === 'number' ) ent.v.max_health = ent.v.health;

	}

	return ent;

}

function _spawnWave() {

	wave ++;
	const pool = MONSTER_POOL.filter( ( m ) => m.minWave <= wave );
	const count = Math.min( sv_horde_maxsize.value, sv_horde_basecount.value + ( wave - 1 ) * sv_horde_growth.value );
	const healthMult = 1 + ( wave - 1 ) * sv_horde_healthgrowth.value;

	aliveEnts = [];
	let spawned = 0;
	for ( let i = 0; i < count; i ++ ) {

		const originEnt = _pickSpawnOrigin();
		if ( ! originEnt ) break; // no players connected/spawned yet

		const choice = pool[ Math.floor( Math.random() * pool.length ) ];
		const ent = _spawnOne( choice.name, originEnt, healthMult );
		if ( ent ) {

			aliveEnts.push( ent );
			spawned ++;

		}

	}

	if ( spawned === 0 ) {

		// Nobody to spawn near -- try again shortly rather than stalling forever.
		wave --;
		waveTimer = realtime + sv_horde_wavedelay.value;
		return;

	}

	SV_BroadcastPrintf( 'Horde wave ' + wave + ': ' + spawned + ' monsters incoming!\n' );

}

export function Horde_Start() {

	if ( active ) return;
	active = true;
	wave = 0;
	aliveEnts = [];
	waveTimer = realtime + sv_horde_startdelay.value;
	SV_BroadcastPrintf( 'Horde mode started -- survive the waves!\n' );

}

export function Horde_Stop() {

	if ( ! active ) return;
	active = false;
	aliveEnts = [];
	waveTimer = 0;
	SV_BroadcastPrintf( 'Horde mode stopped.\n' );

}

export function Horde_Active() {

	return active;

}

/*
=================
Horde_Think

Call once per server frame (see Host_ServerFrame in host.js).
=================
*/
export function Horde_Think() {

	if ( ! active || ! sv.active ) return;

	aliveEnts = aliveEnts.filter( ( e ) => e && ! e.free && e.v.health > 0 );

	if ( aliveEnts.length > 0 ) return;

	if ( waveTimer === 0 ) {

		waveTimer = realtime + sv_horde_wavedelay.value;
		SV_BroadcastPrintf( 'Wave ' + wave + ' cleared! Next wave in ' + sv_horde_wavedelay.value + 's...\n' );

	} else if ( realtime >= waveTimer ) {

		waveTimer = 0;
		_spawnWave();

	}

}

function Horde_Start_f() {

	if ( cmd_source === src_command ) {

		Cmd_ForwardToServer();
		return;

	}

	if ( pr_global_struct.deathmatch !== 0 && host_client.privileged === false ) return;
	Horde_Start();

}

function Horde_Stop_f() {

	if ( cmd_source === src_command ) {

		Cmd_ForwardToServer();
		return;

	}

	if ( pr_global_struct.deathmatch !== 0 && host_client.privileged === false ) return;
	Horde_Stop();

}

/*
=================
Horde_Status_f

Read-only, no privilege check -- anyone in the room can check what's
going on without needing to be the host.
=================
*/
function Horde_Status_f() {

	if ( cmd_source === src_command ) {

		Cmd_ForwardToServer();
		return;

	}

	if ( ! active ) {

		SV_ClientPrintf( 'Horde mode is not running. Use "horde_start" to begin.\n' );
		return;

	}

	SV_ClientPrintf( 'Horde mode: wave ' + wave + ', ' + aliveEnts.length + ' monster(s) alive.\n' );
	SV_ClientPrintf( 'startdelay=' + sv_horde_startdelay.value + ' wavedelay=' + sv_horde_wavedelay.value +
		' basecount=' + sv_horde_basecount.value + ' growth=' + sv_horde_growth.value +
		' maxsize=' + sv_horde_maxsize.value + ' healthgrowth=' + sv_horde_healthgrowth.value + '\n' );

}

export function Horde_Init() {

	Cvar_RegisterVariable( sv_horde_startdelay );
	Cvar_RegisterVariable( sv_horde_wavedelay );
	Cvar_RegisterVariable( sv_horde_basecount );
	Cvar_RegisterVariable( sv_horde_growth );
	Cvar_RegisterVariable( sv_horde_maxsize );
	Cvar_RegisterVariable( sv_horde_healthgrowth );

	Cmd_AddCommand( 'horde_start', Horde_Start_f );
	Cmd_AddCommand( 'horde_stop', Horde_Stop_f );
	Cmd_AddCommand( 'horde_status', Horde_Status_f );

}
