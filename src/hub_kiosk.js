// The hub's in-world kiosk: walk up to it, press E, pick a map and a game
// mode, hit Start -- and everyone standing in the hub is pulled into that
// match together (the lobby does the pulling, see handleHubStart in
// server/lobby_server.js). This replaces the per-player Travel overlay as
// the way a group decides where to go next; travel_ui.js still works as the
// solo escape hatch.
//
// The panel itself is plain DOM, same styling vocabulary as travel_ui.js.
// What's "worldspace" here is the trigger: a prop mesh standing in the hub
// map and a per-frame distance check against the player's eye position.

import * as THREE from 'three';
import { Con_Printf } from './common.js';
import { fetchMapdb } from './auth_client.js';
import { WS_SendHubStart } from './net_websocket.js';
import { cl, cls, ca_connected } from './client.js';
import { r_refdef } from './render.js';
import { scene } from './gl_rmain.js';
import {
	HUB_MAP, HUB_MODES, HUB_MODE_TITLES, HUB_MAX_TEAMS,
	HUB_KIOSK_RANGE, HUB_KIOSK_SPAWN_OFFSET,
} from './hub_config.js';

let panelEl = null;
let promptEl = null;
let kioskMesh = null;
let kioskWorldName = ''; // worldmodel the current mesh was placed for
let inRange = false;
let mapdbCache = null;

/**
 * Pull the first info_player_start out of a compiled map's entity lump.
 * The hub map isn't purpose-built (no kiosk entity to read a spot from --
 * see src/hub_config.js), so this is what anchors the prop.
 */
function Kiosk_FindPlayerStart( entities ) {

	if ( typeof entities !== 'string' ) return null;

	for ( const block of entities.split( '}' ) ) {

		if ( ! block.includes( '"info_player_start"' ) ) continue;

		const origin = block.match( /"origin"\s+"([^"]+)"/ );
		if ( origin === null ) continue;

		const parts = origin[ 1 ].trim().split( /\s+/ ).map( Number );
		if ( parts.length < 3 || parts.some( isNaN ) ) continue;

		const angle = block.match( /"angle"\s+"([^"]+)"/ );

		return { origin: parts, angle: angle === null ? 0 : Number( angle[ 1 ] ) || 0 };

	}

	return null;

}

function Kiosk_Place() {

	const world = cl.worldmodel;
	if ( world == null || scene == null ) return;
	if ( kioskWorldName === world.name ) return;

	Kiosk_Remove();
	kioskWorldName = world.name;

	// Only the hub gets a kiosk -- travelling into a match shouldn't carry it
	// along.
	if ( world.name !== 'maps/' + HUB_MAP + '.bsp' ) return;

	const start = Kiosk_FindPlayerStart( world.entities );
	if ( start === null ) {

		Con_Printf( 'Hub kiosk: no info_player_start in ' + world.name + '\n' );
		return;

	}

	// Push it out along the way the spawn faces: open space by construction,
	// whichever map is standing in as the hub.
	const yaw = start.angle * Math.PI / 180;
	const x = start.origin[ 0 ] + Math.cos( yaw ) * HUB_KIOSK_SPAWN_OFFSET;
	const y = start.origin[ 1 ] + Math.sin( yaw ) * HUB_KIOSK_SPAWN_OFFSET;
	const z = start.origin[ 2 ];

	// Scene geometry is in raw Quake units and materials are BackSide
	// (front-face culling, see R_SetupGL) -- DoubleSide keeps the box solid
	// from every angle regardless.
	const geometry = new THREE.BoxGeometry( 32, 32, 64 );
	const material = new THREE.MeshBasicMaterial( { color: 0xb23b2e, side: THREE.DoubleSide } );
	kioskMesh = new THREE.Mesh( geometry, material );
	kioskMesh.position.set( x, y, z );
	scene.add( kioskMesh );

}

function Kiosk_Remove() {

	if ( kioskMesh === null ) return;

	if ( scene != null ) scene.remove( kioskMesh );
	kioskMesh.geometry.dispose();
	kioskMesh.material.dispose();
	kioskMesh = null;

}

function setStatus( text, isError ) {

	const statusEl = panelEl && panelEl.querySelector( '.tq-kiosk-status' );
	if ( ! statusEl ) return;
	statusEl.textContent = text || '';
	statusEl.style.color = isError ? '#e0523f' : '#8a7d6e';

}

function syncTeamRow() {

	const mode = panelEl.querySelector( '.tq-kiosk-mode' ).value;
	panelEl.querySelector( '.tq-kiosk-team-row' ).hidden = ( mode !== 'teams' && mode !== 'teams_ai' );

}

async function renderPanel() {

	if ( mapdbCache === null ) mapdbCache = await fetchMapdb();

	const mapSelect = panelEl.querySelector( '.tq-kiosk-map' );
	if ( mapSelect.options.length > 0 ) return;

	for ( const [ mapId, entry ] of Object.entries( mapdbCache ) ) {

		// Same catalog slice the Travel picker offers: mod campaigns and
		// standalone custom maps, not the vanilla episode list.
		if ( entry.category !== 'mod' && entry.category !== 'custom' ) continue;

		const option = document.createElement( 'option' );
		option.value = mapId;
		option.textContent = entry.title;
		mapSelect.appendChild( option );

	}

}

function startMatch() {

	const mode = panelEl.querySelector( '.tq-kiosk-mode' ).value;

	try {

		WS_SendHubStart( {
			mapId: panelEl.querySelector( '.tq-kiosk-map' ).value,
			mode,
			teamCount: parseInt( panelEl.querySelector( '.tq-kiosk-teams' ).value, 10 ),
		} );

	} catch ( e ) {

		setStatus( 'Failed: ' + e.message, true );
		return;

	}

	// Stays up until this client gets its own TRAVEL_TO back and travel_ui
	// starts switching rooms.
	setStatus( 'Starting…' );

}

function showPanel() {

	panelEl.hidden = false;
	setStatus( '' );

	// The panel is mouse-driven; the game is holding the pointer.
	if ( document.exitPointerLock ) document.exitPointerLock();

	renderPanel().then( syncTeamRow ).catch( ( e ) => setStatus( 'Failed: ' + e.message, true ) );

}

function hidePanel() {

	panelEl.hidden = true;

}

function handleKeyDown( event ) {

	if ( event.key === 'Escape' && ! panelEl.hidden ) {

		hidePanel();
		return;

	}

	if ( event.key !== 'e' && event.key !== 'E' ) return;
	if ( event.target !== document.body && event.target !== document.documentElement ) return;

	if ( ! panelEl.hidden ) hidePanel();
	else if ( inRange ) showPanel();

}

/*
=============
HubKiosk_Frame

Called once per rendered frame from main.js. Keeps the prop in sync with
whatever map is loaded and drives the proximity prompt.
=============
*/
export function HubKiosk_Frame() {

	if ( panelEl === null ) return;

	if ( cls.state !== ca_connected ) {

		Kiosk_Remove();
		kioskWorldName = '';
		inRange = false;
		promptEl.hidden = true;
		return;

	}

	Kiosk_Place();

	if ( kioskMesh === null ) {

		inRange = false;
		promptEl.hidden = true;
		return;

	}

	const dx = r_refdef.vieworg[ 0 ] - kioskMesh.position.x;
	const dy = r_refdef.vieworg[ 1 ] - kioskMesh.position.y;
	const dz = r_refdef.vieworg[ 2 ] - kioskMesh.position.z;
	inRange = ( dx * dx + dy * dy + dz * dz ) <= HUB_KIOSK_RANGE * HUB_KIOSK_RANGE;

	promptEl.hidden = ! inRange || ! panelEl.hidden;

}

export function HubKiosk_Init() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#tq-kiosk-prompt {
			position: fixed; left: 50%; bottom: 22%; transform: translateX(-50%); z-index: 50;
			font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
			background: rgba(23,19,16,0.85); color: #d8cfc4; border: 1px solid #332920;
			border-radius: 5px; padding: 6px 12px; font-size: 13px; pointer-events: none;
		}
		#tq-kiosk-panel {
			position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 52;
			width: 300px;
			font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
			background: #171310; border: 1px solid #332920; border-radius: 8px; padding: 14px;
		}
		#tq-kiosk-panel h3 { margin: 0 0 10px; font-size: 13px; color: #8a7d6e; text-transform: uppercase; letter-spacing: 1px; }
		.tq-kiosk-row { margin-bottom: 9px; }
		.tq-kiosk-row label { display: block; font-size: 11px; color: #8a7d6e; margin-bottom: 3px; text-transform: uppercase; }
		.tq-kiosk-row select {
			width: 100%; background: #0f0c0a; border: 1px solid #332920; color: #d8cfc4;
			border-radius: 5px; padding: 7px 8px; font-size: 13px;
		}
		#tq-kiosk-panel button {
			width: 100%; background: #0f0c0a; border: 1px solid #332920; color: #d8cfc4;
			border-radius: 5px; padding: 9px 11px; font-size: 13px; cursor: pointer;
		}
		#tq-kiosk-panel button:hover { border-color: #b23b2e; }
		.tq-kiosk-status { font-size: 11.5px; min-height: 14px; margin-top: 6px; }
	`;
	document.head.appendChild( style );

	promptEl = document.createElement( 'div' );
	promptEl.id = 'tq-kiosk-prompt';
	promptEl.textContent = 'Press E to use';
	promptEl.hidden = true;
	document.body.appendChild( promptEl );

	panelEl = document.createElement( 'div' );
	panelEl.id = 'tq-kiosk-panel';
	panelEl.hidden = true;

	const modeOptions = HUB_MODES
		.map( ( mode ) => '<option value="' + mode + '">' + HUB_MODE_TITLES[ mode ] + '</option>' )
		.join( '' );

	let teamOptions = '';
	for ( let n = 2; n <= HUB_MAX_TEAMS; n ++ ) teamOptions += '<option value="' + n + '">' + n + '</option>';

	panelEl.innerHTML = '<h3>Start a match</h3>' +
		'<div class="tq-kiosk-row"><label>World</label><select class="tq-kiosk-map"></select></div>' +
		'<div class="tq-kiosk-row"><label>Mode</label><select class="tq-kiosk-mode">' + modeOptions + '</select></div>' +
		'<div class="tq-kiosk-row tq-kiosk-team-row" hidden><label>Teams</label><select class="tq-kiosk-teams">' + teamOptions + '</select></div>' +
		'<button class="tq-kiosk-start">Start</button>' +
		'<div class="tq-kiosk-status"></div>';
	document.body.appendChild( panelEl );

	panelEl.querySelector( '.tq-kiosk-mode' ).addEventListener( 'change', syncTeamRow );
	panelEl.querySelector( '.tq-kiosk-start' ).addEventListener( 'click', startMatch );

	document.addEventListener( 'keydown', handleKeyDown );

}
