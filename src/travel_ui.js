// In-game "Travel" overlay: a solo escape hatch that lets a player already
// inside a match jump to a different world in the (admin-editable) map
// catalog, without going back through the hub page first. Everyone who
// picks the same world from here lands in the same room automatically (see
// roomIdForMap below) -- picking a level *together* is hub.html's job now,
// this is just for "I'm done here, take me somewhere else."

import { Cbuf_AddText } from './cmd.js';
import { WS_CreateRoom, WS_SetConnectionLostHandler } from './net_websocket.js';
import { Con_Printf } from './common.js';
import { fetchMapdb, logout } from './auth_client.js';
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
 * Move this client to `mapId`, solo -- the manual picker below is the only
 * caller now that group "start together" lives in hub.html instead.
 */
async function travelTo( mapId, entry ) {

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
		const roomId = roomIdForMap( mapId );

		await WS_CreateRoom( serverUrl, {
			map: mapId,
			mod: ( entry.layers || [] ).join( ',' ),
			maxPlayers: 16,
			specificId: roomId,
		} );

		if ( myGeneration !== travelGeneration ) return; // superseded mid-create

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
 * "Leaving a level returns you to the hub" (v1 build order item 7). The hub
 * is a plain web page now, not a room -- so returning to it is just a page
 * navigation, no disconnect/reconnect dance needed. cls/sv state doesn't
 * need cleanup either: the browser's about to tear this whole page down.
 */
export function TravelUI_ReturnToHub() {

	window.location.href = 'hub.html';

}

export function TravelUI_Init( alreadyLoadedModDirs ) {

	for ( const dir of ( alreadyLoadedModDirs || [] ) ) loadedModDirs.add( dir );

	WS_SetConnectionLostHandler( ( failedHost, error ) => {

		// The stored token itself was the problem (expired/revoked/never
		// valid) -- logging back in is the only way forward, and hub.html's
		// own login gate handles that once there.
		if ( error && error.authFailure ) {

			Con_Printf( 'Session expired -- returning to login.\n' );
			logout();
			return;

		}

		Con_Printf( 'Connection lost -- returning to the hub.\n' );
		TravelUI_ReturnToHub();

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
