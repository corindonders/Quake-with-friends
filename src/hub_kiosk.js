// The hub's in-world kiosk: walk up to it, press E, pick a map and a game
// mode, hit Start -- and everyone standing in the hub is pulled into that
// match together (the lobby does the pulling, see handleHubStart in
// server/lobby_server.js). This replaces the per-player Travel overlay as
// the way a group decides where to go next; travel_ui.js still works as the
// solo escape hatch.
//
// The panel itself is plain DOM, same styling vocabulary as travel_ui.js.
// Uses the generic WorldspaceUITrigger framework for the interaction system.

import { Con_Printf } from './common.js';
import { fetchMapdb } from './auth_client.js';
import { WS_SendHubStart } from './net_websocket.js';
import { cl } from './client.js';
import { scene } from './gl_rmain.js';
import { WorldspaceUITrigger, WorldspaceUIPanel } from './worldspace_ui.js';
import {
	HUB_MAP, HUB_MODES, HUB_MODE_TITLES, HUB_MAX_TEAMS,
	HUB_KIOSK_RANGE, HUB_KIOSK_SPAWN_OFFSET,
} from './hub_config.js';

let trigger = null;
let panel = null;
let panelEl = null;
let promptEl = null;
let mapdbCache = null;

/**
 * Pull the first info_player_start out of a compiled map's entity lump.
 * The hub map isn't purpose-built (no kiosk entity to read a spot from --
 * see src/hub_config.js), so this is what anchors the kiosk trigger.
 */
function FindPlayerStart( entities ) {

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

/**
 * Calculate kiosk position based on the map's spawn point.
 */
function CalculateKioskPosition() {

	const world = cl.worldmodel;
	if ( world == null ) return null;

	// Only the hub gets a kiosk
	if ( world.name !== 'maps/' + HUB_MAP + '.bsp' ) return null;

	const start = FindPlayerStart( world.entities );
	if ( start === null ) return null;

	// Push it out along the way the spawn faces
	const yaw = start.angle * Math.PI / 180;
	const x = start.origin[ 0 ] + Math.cos( yaw ) * HUB_KIOSK_SPAWN_OFFSET;
	const y = start.origin[ 1 ] + Math.sin( yaw ) * HUB_KIOSK_SPAWN_OFFSET;
	const z = start.origin[ 2 ];

	return [ x, y, z ];

}

function setStatus( text, isError ) {

	const statusEl = panelEl && panelEl.querySelector( '.tq-kiosk-status' );
	if ( ! statusEl ) return;
	statusEl.textContent = text || '';
	statusEl.style.color = isError ? '#e0523f' : '#8a7d6e';

}

function syncTeamRow() {

	if ( ! panelEl ) return;
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



/*
=============
HubKiosk_Frame

Called once per rendered frame from main.js. Updates the trigger state.
=============
*/
export function HubKiosk_Frame() {

	if ( trigger === null ) return;

	trigger.frame();

}

export function HubKiosk_Init() {

	// Style the UI elements
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

	// Create prompt element (shown when in range)
	promptEl = document.createElement( 'div' );
	promptEl.id = 'tq-kiosk-prompt';
	promptEl.textContent = 'Press E to use';
	promptEl.hidden = true;
	document.body.appendChild( promptEl );

	// Create panel element (shown when interacting)
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

	// Wire up panel events
	panelEl.querySelector( '.tq-kiosk-mode' ).addEventListener( 'change', syncTeamRow );
	panelEl.querySelector( '.tq-kiosk-start' ).addEventListener( 'click', startMatch );

	// Create the worldspace trigger
	trigger = new WorldspaceUITrigger( {
		world: cl.worldmodel,
		scene: scene,
		position: [ 0, 0, 0 ], // will be updated in onProximityEnter
		range: HUB_KIOSK_RANGE,
		color: 0xb23b2e,
		size: { width: 32, height: 32, depth: 64 },
		onProximityEnter: () => {

			promptEl.hidden = false;

		},
		onProximityExit: () => {

			promptEl.hidden = true;

		},
		onInteract: () => {

			panel.show();

		},
	} );

	// Recalculate position when entering proximity
	const originalProximityEnter = trigger.onProximityEnter;
	trigger.onProximityEnter = () => {

		// Update trigger position based on current map spawn point
		const pos = CalculateKioskPosition();
		if ( pos ) {

			trigger.position = pos;
			if ( trigger.mesh ) {

				trigger.mesh.position.set( ...pos );

			}

		}

		originalProximityEnter();

	};

	// Create the panel helper
	panel = new WorldspaceUIPanel( {
		element: panelEl,
		showPrompt: () => {

			// Request pointer lock when showing panel
			if ( document.exitPointerLock ) document.exitPointerLock();
			renderPanel().then( syncTeamRow ).catch( ( e ) => setStatus( 'Failed: ' + e.message, true ) );

		},
		hidePrompt: () => {

			// No special action needed on hide

		},
	} );

	// Register the trigger's keyboard handler
	trigger.registerKeyHandler();

}
