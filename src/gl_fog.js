// Quake fog support: a worldspawn "fog" key (read straight off the raw
// entity lump, same trick as gl_skybox.js's sky key -- vanilla QuakeC has
// no such field) and the FitzQuake-style "fog" console command that mods
// stuff to clients to change it at runtime (e.g. Copper's fog.qc calls
// `stuffcmd(client, "fog <density> <r> <g> <b>\n")` on spawn/trigger,
// matching QuakeSpasm's Fog_f exactly).
//
// Both funnel into the same THREE.FogExp2 applied to the scene -- density
// and color are otherwise identical concepts whether they came from the
// map file or a live server command.

import * as THREE from 'three';
import { Con_Printf } from './console.js';
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from './cmd.js';

let _scene = null;
let _density = 0;
let _color = new THREE.Color( 0.3, 0.3, 0.3 );

/*
=================
R_ExtractWorldspawnFog

Pulls the "fog" (or "_fog") value -- "density red green blue", same format
ericw-tools/QuakeSpasm use -- out of a map's raw entity lump text (always
worldspawn, the first entity block).
=================
*/
export function R_ExtractWorldspawnFog( entitiesText ) {

	if ( ! entitiesText ) return '';

	const blockEnd = entitiesText.indexOf( '}' );
	const block = blockEnd >= 0 ? entitiesText.slice( 0, blockEnd ) : entitiesText;

	let m = block.match( /"fog"\s*"([^"]*)"/ );
	if ( ! m ) m = block.match( /"_fog"\s*"([^"]*)"/ );

	return m ? m[ 1 ].trim() : '';

}

function _applyFog( density, r, g, b ) {

	_density = Math.max( 0, density || 0 );
	if ( r !== undefined ) _color.setRGB( r, g, b );

	if ( ! _scene ) return;

	if ( _density <= 0 ) {

		_scene.fog = null;
		return;

	}

	// QuakeSpasm stores the map/command's raw density (also what "fog" with no
	// args prints) but divides by 64 only at the point it hands density to GL's
	// GL_EXP2 fog (Fog_SetupFrame: glFogf(GL_FOG_DENSITY, Fog_GetDensity()/64.0)).
	// THREE.FogExp2 implements that same GL_EXP2 formula, so it needs the same
	// /64 scale-down here -- passing the raw worldspawn/command value straight
	// through (as before) made every map's fog ~64x too dense, fully whiting
	// (or blacking) out the view within a few dozen units.
	const glDensity = _density / 64;

	if ( _scene.fog && _scene.fog.isFogExp2 ) {

		_scene.fog.density = glDensity;
		_scene.fog.color.copy( _color );

	} else {

		_scene.fog = new THREE.FogExp2( _color.getHex(), glDensity );

	}

}

/*
=================
R_SetMapFog

Called once per map load (see R_NewMap in gl_rmain.js) with whatever
R_ExtractWorldspawnFog found. Empty string clears any previous map's fog.
Also remembers `scene` for the "fog" console command below, which fires
later/independently (e.g. stuffed by a mod on player spawn).
=================
*/
export function R_SetMapFog( fogString, scene ) {

	_scene = scene;

	const parts = ( fogString || '' ).trim().split( /\s+/ ).filter( ( s ) => s.length > 0 ).map( Number );

	if ( parts.length >= 4 && parts.every( ( n ) => ! isNaN( n ) ) ) {

		_applyFog( parts[ 0 ], parts[ 1 ], parts[ 2 ], parts[ 3 ] );

	} else if ( parts.length === 1 && ! isNaN( parts[ 0 ] ) ) {

		_applyFog( parts[ 0 ] );

	} else {

		_applyFog( 0 );

	}

}

/*
=================
Fog_f

Console command: "fog <density> [red green blue]", or bare "fog" to print
the current values. Matches QuakeSpasm's fog command, which is what mods
compiled against it (e.g. Copper) stuff to the client.
=================
*/
function Fog_f() {

	const argc = Cmd_Argc();

	if ( argc <= 1 ) {

		Con_Printf( 'Density is ' + _density.toFixed( 3 ) + ', color is '
			+ _color.r.toFixed( 2 ) + ' ' + _color.g.toFixed( 2 ) + ' ' + _color.b.toFixed( 2 ) + '\n' );
		return;

	}

	const density = parseFloat( Cmd_Argv( 1 ) );
	if ( isNaN( density ) ) return;

	if ( argc >= 5 ) {

		const r = parseFloat( Cmd_Argv( 2 ) );
		const g = parseFloat( Cmd_Argv( 3 ) );
		const b = parseFloat( Cmd_Argv( 4 ) );
		_applyFog( density, r, g, b );

	} else {

		_applyFog( density );

	}

}

/*
=================
Fog_Init

Registers the "fog" console command. "r_skyfog" (fog density applied to the
skybox itself) is accepted but not yet implemented -- accepting it keeps
mods that stuff it (Copper) from spamming "unknown command" rather than
actually blending fog into the sky.
=================
*/
export function Fog_Init() {

	Cmd_AddCommand( 'fog', Fog_f );
	Cmd_AddCommand( 'r_skyfog', () => {} );

}
