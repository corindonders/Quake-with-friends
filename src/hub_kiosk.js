// The hub's in-world kiosk: walk up to it, press E, pick a map and a game
// mode, hit Start -- and everyone standing in the hub is pulled into that
// match together (the lobby does the pulling, see handleHubStart in
// server/lobby_server.js). This replaces the per-player Travel overlay as
// the way a group decides where to go next; travel_ui.js still works as the
// solo escape hatch.
//
// The panel is plain DOM (same styling vocabulary as travel_ui.js) but is
// positioned and oriented as an actual object in the 3D scene via
// WorldspaceUIPanel3D/CSS3DRenderer, not a flat screen-space overlay --
// walking around it changes what you see, same as any other prop.

import { fetchMapdb } from './auth_client.js';
import { WS_SendHubStart, WS_SetHubStartFailedHandler } from './net_websocket.js';
import { cl } from './client.js';
import { scene } from './gl_rmain.js';
import { WorldspaceUITrigger, WorldspaceUIPanel3D } from './worldspace_ui.js';
import {
	HUB_MAP, HUB_MODES, HUB_MODE_TITLES, HUB_MAX_TEAMS, HUB_KIOSK_RANGE,
	HUB_KIOSK_POSITION, HUB_KIOSK_PANEL_POSITION, HUB_KIOSK_PANEL_FACING,
} from './hub_config.js';

let trigger = null;
let panel = null;
let panelEl = null;
let promptEl = null;
let mapdbCache = null;

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
			/* Position/rotation/scale come from WorldspaceUIPanel3D (CSS3DObject) --
			   this element lives in the 3D scene, not screen space. */
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

	// Create panel element (shown when interacting). Visibility is driven
	// entirely by whether WorldspaceUIPanel3D has added it to the CSS3D
	// scene, not by the `hidden` attribute -- leave it unset so the element
	// isn't display:none the moment it gets inserted on show().
	panelEl = document.createElement( 'div' );
	panelEl.id = 'tq-kiosk-panel';

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
	// Not appended to the document here: WorldspaceUIPanel3D's CSS3DObject
	// inserts it into the CSS3D render layer once shown, and removes it on
	// hide (see css3d_layer.js) -- leaving it detached until then keeps it
	// from flashing onto the page in the wrong (screen-space) spot.

	// Wire up panel events
	panelEl.querySelector( '.tq-kiosk-mode' ).addEventListener( 'change', syncTeamRow );
	panelEl.querySelector( '.tq-kiosk-start' ).addEventListener( 'click', startMatch );

	// Create the panel: a real object in the 3D scene, positioned/oriented
	// by CalculateKioskLayout() below whenever the map (re)loads.
	panel = new WorldspaceUIPanel3D( {
		element: panelEl,
		scale: 0.15, // 300px-wide panel -> 45 world units, ~1.4x player width
		showPrompt: () => {

			// Request pointer lock when showing panel
			if ( document.exitPointerLock ) document.exitPointerLock();
			renderPanel().then( syncTeamRow ).catch( ( e ) => setStatus( 'Failed: ' + e.message, true ) );

		},
		hidePrompt: () => {

			// No special action needed on hide

		},
	} );

	// Create the worldspace trigger (the box a player walks up to and
	// presses E on). Position gets filled in below, once per map load.
	trigger = new WorldspaceUITrigger( {
		world: cl.worldmodel,
		scene: scene,
		position: [ 0, 0, 0 ],
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

	// Lay out the trigger box and panel at their fixed HUB_MAP coordinates
	// (see hub_config.js) whenever the trigger (re)places its mesh for a
	// newly-loaded world. Only the hub map gets a kiosk at all, so this also
	// has to override place() rather than just patching the position
	// afterward -- the base implementation doesn't know which maps should
	// have no trigger.
	const originalPlace = trigger.place.bind( trigger );
	const originalRemove = trigger.remove.bind( trigger );

	trigger.place = () => {

		const world = cl.worldmodel;

		if ( world == null || world.name !== 'maps/' + HUB_MAP + '.bsp' ) {

			originalRemove();
			panel.hide();
			return;

		}

		trigger.position = HUB_KIOSK_POSITION;
		originalPlace();
		if ( trigger.mesh ) trigger.mesh.position.set( ...HUB_KIOSK_POSITION );

		panel.setTransform( HUB_KIOSK_PANEL_POSITION, HUB_KIOSK_PANEL_FACING );

	};

	// Register the trigger's keyboard handler, plus "shoot it to open it"
	// -- aim at the kiosk and fire instead of walking up and pressing E.
	trigger.registerKeyHandler();
	trigger.registerShootHandler();

	// Without this, a rejected HUB_START_MAP (no map picked, room limit
	// reached, ...) left the panel stuck on "Starting..." forever -- the
	// server's HUB_START_FAILED reply only ever reached the console.
	WS_SetHubStartFailedHandler( ( error ) => {

		setStatus( 'Failed: ' + error, true );

	} );

}
