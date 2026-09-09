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
import { M_ConnectionError, M_Menu_Main_f } from './menu.js';
import { set_key_dest, key_menu } from './keys.js';

let ws_initialized = false;

// Session token from the login flow (see login.html / src/auth_client.js).
let ws_authToken = '';

export function WS_SetAuthToken( token ) {

	ws_authToken = token || '';

}

const ws_connections = new Map(); // qsocket_t -> WSConnection

class WSConnection {

	constructor( socket ) {

		this.socket = socket;
		this.connected = false;
		this.pendingMessages = []; // { data: Uint8Array, reliable: boolean }
		this.error = null;

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

					reject( new Error( parsed.error ) );
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

				} else {

					reject( new Error( event.reason || 'Connection closed' ) );

				}

			} );

		} );

		// Now in game-data mode: binary frames are Quake packets.
		socket.addEventListener( 'message', ( event ) => {

			if ( typeof event.data === 'string' ) return; // ignore stray control frames

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

		Con_Printf( 'WebSocket connection established\n' );
		return sock;

	} catch ( error ) {

		NET_FreeQSocket( sock );
		Con_Printf( 'WS_Connect error: ' + error.message + '\n' );

		if ( typeof window !== 'undefined' && window.location.search.includes( 'room=' ) ) {

			history.replaceState( null, '', window.location.pathname );

		}

		M_Menu_Main_f();
		set_key_dest( key_menu );

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

	const conn = sock.driverdata;
	if ( ! conn ) return;

	conn.connected = false;

	try { conn.socket.close(); } catch ( e ) { /* ignore */ }

	ws_connections.delete( sock );

}
