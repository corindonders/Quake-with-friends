// In-game "Travel" overlay: lets a player leave the hub (or any room) and
// jump to one of the worlds in the (admin-editable) map catalog. Everyone who picks the
// same world lands in the same room automatically (see roomIdForMap below),
// no code-sharing needed -- that's the "load into worlds together" part of
// the hub.

import { Cbuf_AddText } from './cmd.js';
import { WS_CreateRoom, WS_SetTravelHandler } from './net_websocket.js';
import { Con_Printf } from './common.js';
import { fetchMapdb } from './auth_client.js';
import { COM_LoadMod } from './pak.js';

let panelEl = null;
let buttonEl = null;
let mapdbCache = null;

// Mod dirs already layered in this page session. main.js loads whatever
// the initial page load needed (the hub's mods/copper, or a directly-linked
// map's own layers) and reports them via TravelUI_Init -- anything a travel
// destination needs beyond that has to be loaded here too, since travelling
// reuses the same page/WS connection instead of a fresh navigation (see
// travelTo below).
const loadedModDirs = new Set();

// Bumped on every travelTo() call, and checked after each await inside it.
// The hub's "host starts for all" broadcast means this client can receive a
// second TRAVEL_TO (a different player starting a different match, or a
// stray double-click of its own) while an earlier one is still mid-flight
// (loading mods, waiting on WS_CreateRoom, ...). Without this, both calls
// would eventually reach the disconnect/connect Cbuf commands and interleave
// them, leaving the player briefly connected to the wrong room before a
// second reconnect corrects it. A call that finds itself stale here just
// bails out silently -- the newer call is the one whose commands should win.
let travelGeneration = 0;

/**
 * Deterministic 6-char room ID for a given map id, so every client that
 * picks the same destination requests the same room.
 */
function roomIdForMap( mapId ) {

	let hash = 0;
	for ( let i = 0; i < mapId.length; i ++ ) {

		hash = ( hash * 31 + mapId.charCodeAt( i ) ) | 0;

	}

	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let id = 'W'; // fixed prefix marks these as world rooms, not random/shared-link ones
	let h = Math.abs( hash );
	for ( let i = 0; i < 5; i ++ ) {

		id += chars[ h % chars.length ];
		h = Math.floor( h / chars.length );

	}

	return id;

}

async function loadMapdb() {

	if ( mapdbCache ) return mapdbCache;

	mapdbCache = await fetchMapdb();
	return mapdbCache;

}

function escapeHTML( s ) {

	const div = document.createElement( 'div' );
	div.textContent = s;
	return div.innerHTML;

}

/**
 * Move this client to `mapId`. Two callers: the manual picker below (which
 * derives the room from the map alone), and the hub kiosk's TRAVEL_TO
 * broadcast (see TravelUI_TravelTo), which passes the room the lobby has
 * already created with the chosen game mode attached.
 */
async function travelTo( mapId, entry, existingRoomId ) {

	const myGeneration = ++travelGeneration;

	setStatus( 'Traveling to ' + entry.title + '…' );

	try {

		// Travelling reuses this same page/connection rather than a fresh
		// navigation, so unlike main.js's initial-load path, any mod dirs
		// this destination needs (custom maps, mission packs, ...) have to
		// be layered in here -- otherwise the client tries to render a map
		// whose loose files (bsp, textures, ...) it never fetched, even
		// though the room server itself loaded them fine independently.
		for ( const dir of ( entry.layers || [] ) ) {

			if ( myGeneration !== travelGeneration ) return; // superseded mid-load
			if ( loadedModDirs.has( dir ) ) continue;
			setStatus( 'Loading ' + dir + '…' );
			await COM_LoadMod( dir );
			loadedModDirs.add( dir );

		}

		const lobby = ( window.THREE_QUAKE_SERVER && window.THREE_QUAKE_SERVER.lobby ) || null;
		if ( ! lobby ) throw new Error( 'No server configured (server-config.js)' );

		const serverUrl = ( window.location.protocol === 'https:' ? 'https://' : 'http://' ) + lobby;
		const roomId = existingRoomId || roomIdForMap( mapId );

		// The kiosk path's room is already up (and already carries the game
		// mode) -- creating it again here would only risk replacing it with
		// a default-mode one.
		if ( ! existingRoomId ) {

			await WS_CreateRoom( serverUrl, {
				map: mapId,
				mod: ( entry.layers || [] ).join( ',' ),
				maxPlayers: 16,
				specificId: roomId,
			} );

			if ( myGeneration !== travelGeneration ) return; // superseded mid-create

		}

		Cbuf_AddText( 'disconnect\n' );
		Cbuf_AddText( 'connect "' + serverUrl + '?room=' + roomId + '"\n' );

		hidePanel();

	} catch ( e ) {

		Con_Printf( 'Travel failed: ' + e.message + '\n' );
		if ( myGeneration === travelGeneration ) setStatus( 'Failed: ' + e.message, true );

	}

}

function setStatus( text, isError ) {

	const statusEl = panelEl && panelEl.querySelector( '.tq-travel-status' );
	if ( ! statusEl ) return;
	statusEl.textContent = text || '';
	statusEl.style.color = isError ? '#e0523f' : '#8a7d6e';

}

async function renderPanel() {

	const mapdb = await loadMapdb();
	const listEl = panelEl.querySelector( '.tq-travel-list' );
	listEl.innerHTML = '';

	for ( const [ mapId, entry ] of Object.entries( mapdb ) ) {

		// Only mod campaigns and standalone custom maps are offered as travel
		// destinations -- vanilla episodes and deathmatch maps are reachable
		// from the full catalog (maps.html) but aren't part of the hub loop.
		if ( entry.category !== 'mod' && entry.category !== 'custom' ) continue;

		const row = document.createElement( 'button' );
		row.className = 'tq-travel-item';
		row.innerHTML = '<span class="tq-travel-title">' + escapeHTML( entry.title ) + '</span>' +
			( entry.mod ? '<span class="tq-travel-badge">' + escapeHTML( entry.mod ) + '</span>' : '' );
		row.addEventListener( 'click', () => travelTo( mapId, entry ) );
		listEl.appendChild( row );

	}

}

function showPanel() {

	panelEl.hidden = false;
	setStatus( '' );
	renderPanel();

}

function hidePanel() {

	panelEl.hidden = true;

}

function togglePanel() {

	if ( panelEl.hidden ) showPanel();
	else hidePanel();

}

/**
 * Travel without the panel, for the hub kiosk's "everyone goes now"
 * broadcast. Looks the destination's catalog entry up itself, since the
 * caller only gets a map id off the wire.
 */
export async function TravelUI_TravelTo( mapId, roomId ) {

	const mapdb = await loadMapdb();
	const entry = mapdb[ mapId ] || { title: mapId, layers: [] };

	await travelTo( mapId, entry, roomId );

}

export function TravelUI_Init( alreadyLoadedModDirs ) {

	for ( const dir of ( alreadyLoadedModDirs || [] ) ) loadedModDirs.add( dir );

	WS_SetTravelHandler( ( msg ) => {

		TravelUI_TravelTo( msg.mapId, msg.roomId ).catch( ( e ) => {

			Con_Printf( 'Travel failed: ' + e.message + '\n' );

		} );

	} );


	const style = document.createElement( 'style' );
	style.textContent = `
		#tq-travel-btn {
			position: fixed; bottom: 16px; right: 16px; z-index: 50;
			font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
			background: #171310; color: #d8cfc4; border: 1px solid #332920;
			border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer;
		}
		#tq-travel-btn:hover { border-color: #b23b2e; }
		#tq-travel-panel {
			position: fixed; bottom: 60px; right: 16px; z-index: 51; width: 280px;
			max-height: 60vh; overflow-y: auto;
			font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
			background: #171310; border: 1px solid #332920; border-radius: 8px;
			padding: 12px;
		}
		#tq-travel-panel h3 { margin: 0 0 10px; font-size: 13px; color: #8a7d6e; text-transform: uppercase; letter-spacing: 1px; }
		.tq-travel-item {
			display: flex; justify-content: space-between; align-items: center; gap: 8px;
			width: 100%; text-align: left; background: #0f0c0a; border: 1px solid #332920;
			color: #d8cfc4; border-radius: 5px; padding: 9px 11px; margin-bottom: 6px;
			font-size: 13px; cursor: pointer;
		}
		.tq-travel-item:hover { border-color: #b23b2e; }
		.tq-travel-badge { font-size: 10px; color: #8a7d6e; text-transform: uppercase; }
		.tq-travel-status { font-size: 11.5px; min-height: 14px; margin-top: 4px; }
	`;
	document.head.appendChild( style );

	buttonEl = document.createElement( 'button' );
	buttonEl.id = 'tq-travel-btn';
	buttonEl.textContent = 'Travel';
	buttonEl.addEventListener( 'click', togglePanel );
	document.body.appendChild( buttonEl );

	panelEl = document.createElement( 'div' );
	panelEl.id = 'tq-travel-panel';
	panelEl.hidden = true;
	panelEl.innerHTML = '<h3>Travel to…</h3><div class="tq-travel-list"></div><div class="tq-travel-status"></div>';
	document.body.appendChild( panelEl );

}
