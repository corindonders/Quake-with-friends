// WebSocket network driver for multiplayer support.
//
// Replaces the WebTransport driver for the small-friend-group deployment:
// WebSockets proxy cleanly through a Cloudflare Tunnel (WebTransport/HTTP-3
// does not -- Cloudflare terminates HTTP/3 at its edge and speaks HTTP/1.1
// or HTTP/2 to the origin, so a real end-to-end QUIC session, which
// WebTransport requires, can never reach the game server through a Tunnel).
//
// Design: ONE persistent WebSocket connection per player, always to the
// lobby's single public endpoint. The lobby handles room list/create/join
// over that same connection (JSON text frames), then -- once a room is
// joined -- transparently relays binary frames between the player and the
// room process's own internal, loopback-only WebSocket listener. Cloudflare
// (or any reverse proxy) only ever needs one ingress rule, forever, no
// matter how many rooms come and go.
//
// Wire format on the single connection:
//   - Text frames: JSON control messages (list/create/join requests and
//     their responses), only meaningful before a room join succeeds.
//   - Binary frames: game data, once joined. First byte is 1 (reliable) or
//     0 (unreliable/informational only -- see USE_CLIENT_OUTBOUND_DATAGRAMS
//     in the old WebTransport driver for why the reliable/unreliable split
//     barely matters here) followed by the raw Quake packet payload.

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket, NET_FreeQSocket } from './net_main.js';
import { net_message } from './net.js';
import { M_ConnectionError } from './menu.js';
import { Cbuf_AddText } from './cmd.js';

let ws_initialized = false;

// Session token from the login flow (see login.html / src/auth_client.js).
let ws_authToken = '';

/*
=============================================================================

Auto-reconnect -- when the single persistent connection drops without the
player asking for it (network blip, room process restart, laptop woke from
sleep), retry the exact same "connect <host>" a few times with backoff
instead of stranding the player on a dead connection. Deliberate
disconnects (WS_Close, e.g. the Travel UI's "disconnect" before switching
rooms) never trigger this -- see the `intentional` flag on WSConnection.

Status is reported via Con_Printf only: while disconnected the engine
already shows a full-screen console (see ca_disconnected in client.js), so
these messages are visible with no extra DOM/overlay of any kind.
=============================================================================
*/

const RECONNECT_DELAYS_MS = [ 1000, 2000, 4000, 8000, 8000, 8000 ];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

let lastConnectHost = null; // host string from the last successful game connection
let reconnectAttempt = 0;
let reconnectTimer = null;
let isReconnecting = false; // true while a retry-driven connect() is in flight

function WS_CancelReconnect() {

	if ( reconnectTimer != null ) {

		clearTimeout( reconnectTimer );
		reconnectTimer = null;

	}

	reconnectAttempt = 0;
	isReconnecting = false;

}

function WS_ScheduleReconnect() {

	if ( reconnectTimer != null ) return; // already counting down to the next try
	if ( ! lastConnectHost ) return;

	if ( reconnectAttempt >= MAX_RECONNECT_ATTEMPTS ) {

		Con_Printf( 'Could not reconnect after ' + MAX_RECONNECT_ATTEMPTS + ' attempts.\n' );
		WS_CancelReconnect();
		return;

	}

	const delay = RECONNECT_DELAYS_MS[ reconnectAttempt ];
	reconnectAttempt ++;

	Con_Printf( 'Connection lost. Reconnecting in ' + ( delay / 1000 ) + 's... (attempt ' +
		reconnectAttempt + '/' + MAX_RECONNECT_ATTEMPTS + ')\n' );

	reconnectTimer = setTimeout( () => {

		reconnectTimer = null;
		isReconnecting = true;
		Cbuf_AddText( 'connect "' + lastConnectHost + '"\n' );

	}, delay );

}

export function WS_SetAuthToken( token ) {

	ws_authToken = token || '';

}

/*
=============
Hub control channel

The gameplay connection keeps carrying text frames after the join: that's
how the in-world kiosk (src/hub_kiosk.js) sends HUB_START_MAP up to the
lobby, and how the lobby's TRAVEL_TO broadcast -- "everyone in the hub, go
to this room now" -- comes back down. No second connection, and nothing the
Quake protocol itself has to know about.
=============
*/

let ws_gameConn = null; // the live gameplay connection, if any
let ws_travelHandler = null;
let ws_hubStartFailedHandler = null;
let ws_connectionLostHandler = null;

export function WS_SetTravelHandler( handler ) {

	ws_travelHandler = handler;

}

// Fires once the auto-reconnect loop below finally gives up on a connection
// (retries exhausted, or an initial/retry connect attempt failed outright)
// -- the game-ending "leaving a level returns you to the hub" case (see
// v1 build order item 7): a match room shutting down (naturally, on idle
// timeout, ...) looks identical to a network blip from here, so this fires
// for both, and it's up to the handler (travel_ui.js) to decide where that
// leaves the player. Called with (host, error): `host` is the URL that
// failed, so the handler can tell "the hub itself is unreachable" apart
// from "some other room died" and avoid looping back into the same
// failure; `error.authFailure` is true when the token itself was the
// problem (expired/revoked/never valid) -- falling back to the hub with
// that same bad token would just fail again, so the handler needs to send
// the player to login.html instead.
export function WS_SetConnectionLostHandler( handler ) {

	ws_connectionLostHandler = handler;

}

// Lets the kiosk panel (src/hub_kiosk.js) show *why* a HUB_START_MAP it
// sent got rejected (no map picked, room limit reached, ...) instead of
// leaving the panel stuck on "Starting..." with no explanation -- see
// WS_SendHubStart below and the HUB_START_FAILED handling further down.
export function WS_SetHubStartFailedHandler( handler ) {

	ws_hubStartFailedHandler = handler;

}

export function WS_SendHubStart( config ) {

	if ( ws_gameConn == null || ws_gameConn.socket.readyState !== WebSocket.OPEN ) {

		throw new Error( 'Not connected' );

	}

	ws_gameConn.socket.send( JSON.stringify( { type: 'HUB_START_MAP', config } ) );

}

const ws_connections = new Map(); // qsocket_t -> WSConnection

class WSConnection {

	constructor( socket ) {

		this.socket = socket;
		this.connected = false;
		this.pendingMessages = []; // { data: Uint8Array, reliable: boolean }
		this.error = null;
		this.intentional = false; // set by WS_Close -- suppresses auto-reconnect

	}

}

function normalizeWsUrl( serverUrl ) {

	let url = serverUrl;

	if ( ! url.includes( '://' ) ) {

		url = 'https://' + url;

	}

	// Accept the same range of schemes the old driver's callers/URLs might
	// still use, and legacy wt(s):// values from any saved links.
	url = url.replace( /^http:\/\//, 'ws://' )
		.replace( /^https:\/\//, 'wss://' )
		.replace( /^wt:\/\//, 'ws://' )
		.replace( /^wts:\/\//, 'wss://' );

	const urlObj = new URL( url );
	urlObj.pathname = '/ws';
	urlObj.search = '';

	return urlObj.toString();

}

/*
=============
WS_Init
=============
*/
export function WS_Init() {

	if ( typeof WebSocket === 'undefined' ) {

		Con_Printf( 'WebSocket not available in this browser\n' );
		return - 1;

	}

	ws_initialized = true;
	return 0;

}

export function WS_Shutdown() {

	for ( const [ , conn ] of ws_connections ) {

		try { conn.socket.close(); } catch ( e ) { /* ignore */ }

	}

	ws_connections.clear();
	ws_initialized = false;

}

export function WS_Listen( state ) {

	// Browser clients don't listen for connections.

}

export function WS_SearchForHosts( xmit ) {

	// No broadcast discovery -- use WS_QueryRooms for the room list.

}

export function WS_CheckNewConnections() {

	// Browser clients don't accept connections.
	return null;

}

/*
=============
Lobby control protocol -- one request/response per short-lived connection,
used for the room browser (list) and for creating a room ahead of joining
it (e.g. the in-hub Travel picker).
=============
*/

const LOBBY_TIMEOUT_MS = 10000;

async function lobbyRequest( serverUrl, message ) {

	const url = normalizeWsUrl( serverUrl );
	const socket = new WebSocket( url );
	socket.binaryType = 'arraybuffer';

	return await new Promise( ( resolve, reject ) => {

		const timeout = setTimeout( () => {

			try { socket.close(); } catch ( e ) { /* ignore */ }
			reject( new Error( 'Request timed out' ) );

		}, LOBBY_TIMEOUT_MS );

		socket.addEventListener( 'open', () => {

			socket.send( JSON.stringify( message ) );

		} );

		socket.addEventListener( 'message', ( event ) => {

			clearTimeout( timeout );

			if ( typeof event.data !== 'string' ) {

				reject( new Error( 'Unexpected binary response' ) );
				socket.close();
				return;

			}

			let parsed;
			try {

				parsed = JSON.parse( event.data );

			} catch ( e ) {

				reject( new Error( 'Invalid response from server' ) );
				socket.close();
				return;

			}

			socket.close();

			if ( parsed.error ) {

				reject( new Error( parsed.error ) );
				return;

			}

			resolve( parsed );

		} );

		socket.addEventListener( 'error', () => {

			clearTimeout( timeout );
			reject( new Error( 'Connection to ' + url + ' failed' ) );

		} );

		socket.addEventListener( 'close', () => {

			clearTimeout( timeout );

		} );

	} );

}

export async function WS_QueryRooms( serverUrl ) {

	const response = await lobbyRequest( serverUrl, { type: 'list', token: ws_authToken } );
	return Array.isArray( response.rooms ) ? response.rooms : [];

}

export async function WS_CreateRoom( serverUrl, config ) {

	const response = await lobbyRequest( serverUrl, Object.assign(
		{ type: 'create', token: ws_authToken }, config
	) );
	return response.room;

}

/*
=============
WS_Connect

Opens the single persistent connection used for actual gameplay: connects
to the lobby, sends a join request for roomId (or asks for a fresh default
room if none given), and on success keeps the same socket open as the
game's transport -- from here on the lobby transparently relays binary
frames to/from the room process.
=============
*/
export async function WS_Connect( host ) {

	if ( ! ws_initialized ) {

		throw new Error( 'WebSocket not initialized' );

	}

	// host may be a plain "host:port" or a full URL carrying ?room=ID (see
	// main.js's "connect <serverUrl>?room=<id>" flow for the hub/travel UI).
	let roomId = '';
	try {

		const parsed = new URL( host.includes( '://' ) ? host : 'https://' + host );
		roomId = parsed.searchParams.get( 'room' ) || '';

	} catch ( e ) { /* not a full URL - no room param to extract */ }

	const url = normalizeWsUrl( host );
	Con_Printf( 'Connecting to ' + url + '...\n' );

	const sock = NET_NewQSocket();
	if ( ! sock ) {

		Con_Printf( 'WS_Connect: no free sockets\n' );
		return null;

	}

	sock.address = host;

	try {

		const socket = new WebSocket( url );
		socket.binaryType = 'arraybuffer';

		const conn = new WSConnection( socket );

		await new Promise( ( resolve, reject ) => {

			const timeout = setTimeout( () => reject( new Error( 'Connection timed out' ) ), 30000 );

			socket.addEventListener( 'open', () => {

				socket.send( JSON.stringify( { type: 'join', token: ws_authToken, roomId: roomId || '' } ) );

			} );

			socket.addEventListener( 'message', function onFirstMessage( event ) {

				// First message must be the join response (text/JSON). After
				// this, the socket switches into game-data (binary) mode.
				if ( typeof event.data !== 'string' ) return; // stray binary before join ack -- ignore

				clearTimeout( timeout );
				socket.removeEventListener( 'message', onFirstMessage );

				let parsed;
				try {

					parsed = JSON.parse( event.data );

				} catch ( e ) {

					reject( new Error( 'Invalid response from server' ) );
					return;

				}

				if ( parsed.error ) {

					const err = new Error( parsed.error );
					// The lobby sends this exact text when the session token
					// itself is the problem (expired/revoked/never valid) --
					// distinct from "room's gone" or "server unreachable",
					// both of which the connection-lost handler below
					// reasonably retries/falls back to the hub for. Retrying
					// an invalid token just fails the same way forever, so
					// this needs to send the player to login.html instead.
					if ( parsed.error.indexOf( 'Not logged in' ) === 0 ) err.authFailure = true;
					reject( err );
					return;

				}

				conn.connected = true;
				resolve();

			} );

			socket.addEventListener( 'error', () => {

				clearTimeout( timeout );
				reject( new Error( 'Connection to ' + url + ' failed' ) );

			} );

			socket.addEventListener( 'close', ( event ) => {

				clearTimeout( timeout );
				if ( conn.connected ) {

					conn.connected = false;
					Con_Printf( 'Connection closed' + ( event.reason ? ': ' + event.reason : '' ) + '\n' );

					if ( ! conn.intentional ) {

						WS_ScheduleReconnect();

					}

				} else {

					reject( new Error( event.reason || 'Connection closed' ) );

				}

			} );

		} );

		// Now in game-data mode: binary frames are Quake packets.
		socket.addEventListener( 'message', ( event ) => {

			if ( typeof event.data === 'string' ) {

				let control;
				try { control = JSON.parse( event.data ); } catch ( e ) { return; }

				if ( control.type === 'TRAVEL_TO' && ws_travelHandler != null ) {

					ws_travelHandler( control );

				} else if ( control.type === 'HUB_START_FAILED' ) {

					Con_Printf( 'Could not start the match: ' + control.error + '\n' );
					if ( ws_hubStartFailedHandler != null ) ws_hubStartFailedHandler( control.error );

				}
				return;

			}

			const bytes = new Uint8Array( event.data );
			if ( bytes.length < 1 ) return;

			conn.pendingMessages.push( {
				data: bytes.subarray( 1 ),
				reliable: bytes[ 0 ] === 1,
			} );

		} );

		socket.addEventListener( 'close', () => {

			conn.connected = false;

		} );

		socket.addEventListener( 'error', ( e ) => {

			conn.error = new Error( 'WebSocket error' );
			conn.connected = false;

		} );

		ws_connections.set( sock, conn );
		sock.driverdata = conn;
		ws_gameConn = conn;

		Con_Printf( 'WebSocket connection established\n' );

		// A reconnect just succeeded (or this was a fresh connect) -- either
		// way we have a live connection now, so forget any retry state.
		lastConnectHost = host;
		WS_CancelReconnect();

		return sock;

	} catch ( error ) {

		NET_FreeQSocket( sock );
		Con_Printf( 'WS_Connect error: ' + error.message + '\n' );

		// A retry attempt itself failed (server/room still unreachable) --
		// keep retrying with backoff instead of bailing out to the menu.
		// Not for an auth failure though: retrying with the same bad token
		// can only ever fail the same way.
		if ( ! error.authFailure && isReconnecting && reconnectAttempt < MAX_RECONNECT_ATTEMPTS ) {

			WS_ScheduleReconnect();
			return null;

		}

		WS_CancelReconnect();

		if ( typeof window !== 'undefined' && window.location.search.includes( 'room=' ) ) {

			history.replaceState( null, '', window.location.pathname );

		}

		Con_Printf( 'Connection failed. Check the console for details.\n' );
		if ( ws_connectionLostHandler != null ) ws_connectionLostHandler( host, error );
		return null;

	}

}

/*
=============
WS_QGetMessage
=============
*/
export function WS_QGetMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return - 1;

	if ( ! conn.connected && conn.pendingMessages.length === 0 ) return - 1;

	if ( conn.pendingMessages.length > 0 ) {

		let msg = conn.pendingMessages.shift();

		// Collapse to the newest unreliable message, same as the old driver --
		// an unreliable Quake packet is meant to be superseded by a newer one,
		// not queued.
		if ( ! msg.reliable ) {

			while ( conn.pendingMessages.length > 0 && ! conn.pendingMessages[ 0 ].reliable ) {

				msg = conn.pendingMessages.shift();

			}

		}

		SZ_Clear( net_message );
		SZ_Write( net_message, msg.data, msg.data.length );

		sock.lastMessageTime = performance.now() / 1000;

		return msg.reliable ? 1 : 2;

	}

	if ( conn.connected ) return 0;

	return - 1;

}

function sendFrame( conn, data, reliable ) {

	if ( conn == null || ! conn.connected ) return - 1;
	if ( conn.socket.readyState !== WebSocket.OPEN ) return - 1;

	const frame = new Uint8Array( 1 + data.cursize );
	frame[ 0 ] = reliable ? 1 : 0;
	frame.set( data.data.subarray( 0, data.cursize ), 1 );

	try {

		conn.socket.send( frame );
		return 1;

	} catch ( error ) {

		Con_DPrintf( 'WS send error: ' + error.message + '\n' );
		return - 1;

	}

}

export function WS_QSendMessage( sock, data ) {

	return sendFrame( sock.driverdata, data, true );

}

export function WS_SendUnreliableMessage( sock, data ) {

	return sendFrame( sock.driverdata, data, false );

}

export function WS_CanSendMessage( sock ) {

	const conn = sock.driverdata;
	return !! conn && conn.connected && conn.socket.readyState === WebSocket.OPEN;

}

export function WS_CanSendUnreliableMessage( sock ) {

	return WS_CanSendMessage( sock );

}

export function WS_Close( sock ) {

	// A deliberate close (user disconnect, Travel UI switching rooms, etc.)
	// -- don't try to auto-reconnect to what we're intentionally leaving.
	WS_CancelReconnect();

	const conn = sock.driverdata;
	if ( ! conn ) return;

	conn.intentional = true;
	conn.connected = false;

	try { conn.socket.close(); } catch ( e ) { /* ignore */ }

	ws_connections.delete( sock );
	if ( ws_gameConn === conn ) ws_gameConn = null;

}
