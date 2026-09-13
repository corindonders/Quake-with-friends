// Quake with Friends Lobby Server for Deno
// One HTTP(S) server handles everything: login, the room lobby (list/create/
// join over WebSocket), and relaying gameplay traffic to room processes.
// Rooms are separate Deno processes (room_process_manager.ts); their own
// WebSocket listeners are loopback-only (127.0.0.1) -- this lobby is the
// only thing that ever talks to them directly, relaying bytes for whichever
// player joined. That means exactly one public port/hostname needs to be
// reachable (or tunneled) no matter how many rooms exist.
//
// Usage: deno run --allow-net --allow-read --allow-write --allow-env
//   --allow-run --unstable-net --unstable-kv lobby_server.js
//   [-port 4433] [-cert cert.pem -key key.pem] [-pak ../pak0.pak]
//   [-allow-origin https://yoursite] [-verbose]
//
// TLS is optional: pass -cert/-key to serve HTTPS/WSS directly (e.g. a bare
// port-forwarded deployment), or omit them to serve plain HTTP/WS -- the
// right choice when a reverse proxy or Cloudflare Tunnel is terminating TLS
// in front of this process (cloudflared happily speaks plain HTTP to a
// local origin), and also the easiest way to test locally with no certs at
// all.

import { Sys_Printf } from './sys_server.ts';

// Reduce log write volume in production. Keep only allowlisted lines.
// Pass -verbose (or set THREE_QUAKE_VERBOSE=1) to see everything, e.g. while
// developing locally.
globalThis.__THREE_QUAKE_QUIET_LOGS =
	! Deno.args.includes( '-verbose' ) && Deno.env.get( 'THREE_QUAKE_VERBOSE' ) !== '1';

// Global unhandled rejection handler - prevent server crashes from async errors
globalThis.addEventListener( 'unhandledrejection', ( event ) => {
	Sys_Printf( 'Unhandled promise rejection: %s\n', String( event.reason ) );
	event.preventDefault(); // Prevent default crash behavior
} );
import {
	RoomManager_SetConfig,
	RoomManager_CreateRoom,
	RoomManager_GetRoom,
	RoomManager_ListRooms,
	RoomManager_CleanupIdleRooms,
	RoomManager_CleanupUnhealthyRooms,
	RoomManager_ShutdownAll,
	RoomManager_TerminateRoom,
} from './room_process_manager.ts';
import {
	verifySession, verifyPassword, createSession,
	listUsers, createUser, deleteUser, setUserPassword, setUserAdmin,
	createRoomTicket,
} from './auth.ts';
import { listMaps, getMap, setMap, deleteMap } from './mapdb.ts';
import {
	HUB_ROOM_ID, HUB_MAP, HUB_MOD, HUB_MAX_PLAYERS,
	Hub_NormalizeModeConfig, Hub_RoomIdForConfig,
} from '../src/hub_config.js';

// Server configuration
const CONFIG = {
	port: 4433,
	certFile: '',
	keyFile: '',
	pakPath: '/opt/three-quake/pak0.pak',
	// Comma-separated list of origins allowed to call /login (browser CORS).
	// Set via -allow-origin, e.g. https://yourname.github.io
	allowOrigin: '*',
};

// Parse command line arguments
function parseArgs() {
	const args = Deno.args;
	for ( let i = 0; i < args.length; i++ ) {
		const arg = args[ i ];
		if ( arg === '-port' && args[ i + 1 ] ) {
			CONFIG.port = parseInt( args[ ++i ], 10 );
		} else if ( arg === '-cert' && args[ i + 1 ] ) {
			CONFIG.certFile = args[ ++i ];
		} else if ( arg === '-key' && args[ i + 1 ] ) {
			CONFIG.keyFile = args[ ++i ];
		} else if ( arg === '-pak' && args[ i + 1 ] ) {
			CONFIG.pakPath = args[ ++i ];
		} else if ( arg === '-allow-origin' && args[ i + 1 ] ) {
			CONFIG.allowOrigin = args[ ++i ];
		}
	}
}

const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;

// Every relay connection currently sitting in a room, so the hub kiosk's
// "Start" can pull everyone in the hub into the same match at once.
const roomClients = new Map(); // roomId -> Set<WebSocket>

function RoomClients_Add( roomId, socket ) {

	let set = roomClients.get( roomId );
	if ( set === undefined ) {

		set = new Set();
		roomClients.set( roomId, set );

	}
	set.add( socket );

}

function RoomClients_Remove( roomId, socket ) {

	const set = roomClients.get( roomId );
	if ( set === undefined ) return;

	set.delete( socket );
	if ( set.size === 0 ) roomClients.delete( roomId );

}

function RoomClients_Broadcast( roomId, message ) {

	const set = roomClients.get( roomId );
	if ( set === undefined ) return 0;

	const payload = JSON.stringify( message );
	let sent = 0;
	for ( const socket of set ) {

		if ( socket.readyState !== WebSocket.OPEN ) continue;
		try { socket.send( payload ); sent ++; } catch ( e ) { /* ignore */ }

	}

	return sent;

}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

// Simple per-IP throttle so brute-forcing passwords isn't free. Not meant to
// stop a determined attacker, just to raise the cost past "small friend
// group" scale. Resets are implicit via the sliding window below.
const _loginAttempts = new Map(); // ip -> array of timestamps (ms)
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function _isRateLimited( ip ) {

	const now = Date.now();
	const attempts = ( _loginAttempts.get( ip ) || [] ).filter( ( t ) => now - t < LOGIN_WINDOW_MS );
	attempts.push( now );
	_loginAttempts.set( ip, attempts );
	return attempts.length > LOGIN_MAX_ATTEMPTS;

}

function _corsHeaders() {

	return {
		'Access-Control-Allow-Origin': CONFIG.allowOrigin,
		'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Content-Type': 'application/json',
	};

}

function _json( body, status ) {

	return new Response( JSON.stringify( body ), { status: status || 200, headers: _corsHeaders() } );

}

async function handleLogin( req, address ) {

	if ( _isRateLimited( address ) ) {

		return new Response( JSON.stringify( { error: 'Too many attempts. Try again in a minute.' } ), {
			status: 429, headers: _corsHeaders(),
		} );

	}

	try {

		const body = await req.json();
		const username = String( body.username || '' ).slice( 0, 64 );
		const password = String( body.password || '' ).slice( 0, 256 );

		const user = await verifyPassword( username, password );
		if ( user === null ) {

			return new Response( JSON.stringify( { error: 'Invalid username or password.' } ), {
				status: 401, headers: _corsHeaders(),
			} );

		}

		const token = await createSession( user.username, user.isAdmin );
		Sys_Printf( 'Login: %s from %s\n', user.username, address );

		return new Response( JSON.stringify( { token, username: user.username, isAdmin: user.isAdmin } ), {
			status: 200, headers: _corsHeaders(),
		} );

	} catch ( e ) {

		return new Response( JSON.stringify( { error: 'Bad request.' } ), {
			status: 400, headers: _corsHeaders(),
		} );

	}

}

// ---------------------------------------------------------------------------
// Lobby + relay (WebSocket)
// ---------------------------------------------------------------------------

async function resolveRoomForJoin( rawRoomId ) {

	const roomId = ( rawRoomId || '' ).trim().toUpperCase();
	let room = RoomManager_GetRoom( roomId );

	// The hub can go missing if its process ever got reaped as unhealthy
	// (see RoomManager_CleanupUnhealthyRooms, which now recreates it itself,
	// but a join landing in the gap before that finishes needs the same
	// fallback) -- it needs its real map/mod/persistent config, not the
	// generic shared-link fallback below.
	if ( room === null && roomId === HUB_ROOM_ID ) {

		Sys_Printf( 'Hub room missing on join -- recreating\n' );
		await RoomManager_CreateRoom( {
			map: HUB_MAP,
			mod: HUB_MOD,
			maxPlayers: HUB_MAX_PLAYERS,
			hostName: 'Hub',
			specificId: HUB_ROOM_ID,
			persistent: true,
		} );
		room = RoomManager_GetRoom( HUB_ROOM_ID );

	// A valid-looking room ID that doesn't exist (e.g. an expired shared
	// link) gets a fresh default room rather than a dead end.
	} else if ( room === null && ROOM_ID_PATTERN.test( roomId ) ) {

		Sys_Printf( 'Auto-creating room for link ID: %s\n', roomId );
		await RoomManager_CreateRoom( {
			map: 'rapture1',
			maxPlayers: 4,
			hostName: 'Shared',
			specificId: roomId,
		} );
		room = RoomManager_GetRoom( roomId );

	}

	return room;

}

/**
 * The hub kiosk's "Start": resolve (creating if needed) the room that matches
 * the chosen map + mode, then tell everyone standing in the hub to travel
 * there, so the whole group lands in the same match together.
 */
async function handleHubStart( config ) {

	const normalized = Hub_NormalizeModeConfig( config );
	if ( normalized.mapId.length === 0 ) return { error: 'Pick a map first.' };

	const entry = await getMap( normalized.mapId );
	if ( entry === null ) return { error: 'No such map.' };

	const roomId = Hub_RoomIdForConfig( normalized );
	const mod = ( entry.layers || [] ).join( ',' );

	const result = await RoomManager_CreateRoom( {
		map: normalized.mapId,
		mod,
		maxPlayers: normalized.maxPlayers,
		hostName: 'Hub',
		specificId: roomId,
		mode: normalized.mode,
		teamCount: normalized.teamCount,
	} );

	if ( result === null ) return { error: 'Server room limit reached. Try again later.' };

	const sent = RoomClients_Broadcast( HUB_ROOM_ID, {
		type: 'TRAVEL_TO',
		mapId: normalized.mapId,
		roomId: result.id,
		mode: normalized.mode,
	} );

	Sys_Printf( 'Hub start: %s (%s) -> room %s, %d player(s) travelling\n',
		normalized.mapId, normalized.mode, result.id, sent );

	return { ok: true };

}

function handleWsConnection( socket, address ) {

	let phase = 'control'; // 'control' (JSON lobby requests) | 'relay' (raw game bytes)
	let roomSocket = null;
	let joinedRoomId = null;

	socket.addEventListener( 'message', async ( event ) => {

		if ( phase === 'relay' ) {

			// Text frames stay lobby business even after the join -- that's
			// how the in-world hub kiosk starts a match without opening a
			// second connection. Everything else is raw game data.
			if ( typeof event.data === 'string' ) {

				let relayMsg;
				try { relayMsg = JSON.parse( event.data ); } catch ( e ) { return; }

				if ( relayMsg.type === 'HUB_START_MAP' && joinedRoomId === HUB_ROOM_ID ) {

					const result = await handleHubStart( relayMsg.config );
					if ( result.error ) socket.send( JSON.stringify( { type: 'HUB_START_FAILED', error: result.error } ) );

				}
				return;

			}

			if ( roomSocket && roomSocket.readyState === WebSocket.OPEN ) {

				roomSocket.send( event.data );

			}
			return;

		}

		if ( typeof event.data !== 'string' ) return; // stray binary before a join -- ignore

		let msg;
		try {

			msg = JSON.parse( event.data );

		} catch ( e ) {

			socket.close();
			return;

		}

		const session = await verifySession( msg.token || '' );
		if ( session === null ) {

			socket.send( JSON.stringify( { error: 'Not logged in. Please log in again.' } ) );
			Sys_Printf( 'Rejected unauthenticated lobby request from %s\n', address );
			return;

		}

		if ( msg.type === 'list' ) {

			const rooms = RoomManager_ListRooms();
			socket.send( JSON.stringify( { rooms } ) );
			Sys_Printf( 'Sent room list to %s (%d rooms)\n', address, rooms.length );
			return;

		}

		if ( msg.type === 'create' ) {

			const result = await RoomManager_CreateRoom( {
				map: msg.map || 'rapture1',
				mod: msg.mod || '',
				maxPlayers: msg.maxPlayers || 4,
				hostName: session.username,
				specificId: msg.specificId || undefined,
			} );

			if ( result === null ) {

				socket.send( JSON.stringify( { error: 'Server room limit reached. Try again later.' } ) );
				Sys_Printf( 'Room creation failed for %s (limit reached)\n', address );
				return;

			}

			const room = RoomManager_GetRoom( result.id );
			socket.send( JSON.stringify( { room: room || {
				id: result.id, port: result.port, map: msg.map || 'rapture1', mod: msg.mod || '',
				maxPlayers: msg.maxPlayers || 4, hostName: session.username,
			} } ) );
			Sys_Printf( 'Room %s created on port %d for %s\n', result.id, result.port, address );
			return;

		}

		if ( msg.type === 'join' ) {

			const room = await resolveRoomForJoin( msg.roomId );

			if ( room === null ) {

				socket.send( JSON.stringify( { error: 'Room not found. The game may have ended.' } ) );
				Sys_Printf( 'Room %s unavailable for %s\n', msg.roomId, address );
				return;

			}

			if ( room.playerCount >= room.maxPlayers ) {

				socket.send( JSON.stringify( { error: 'Room is full (' + room.playerCount + '/' + room.maxPlayers + ' players)' } ) );
				return;

			}

			try {

				// Proof to the room process that this connection really did pass
				// the lobby's own auth, not just a direct hit on its loopback
				// port -- see verifyRoomTicket in net_websocket_server.ts's
				// upgrade handler. Short-lived (60s), single use in practice
				// since it's only ever presented once, right here.
				let roomUrl = 'ws://127.0.0.1:' + room.port + '/ws';
				try {

					const ticket = await createRoomTicket( session.username, room.id );
					roomUrl += '?ticket=' + encodeURIComponent( ticket );

				} catch ( ticketError ) {

					Sys_Printf( 'Could not sign a room ticket (%s) -- set THREE_QUAKE_SECRET to enable room-level auth\n', ticketError.message );

				}

				roomSocket = new WebSocket( roomUrl );
				roomSocket.binaryType = 'arraybuffer';

				await new Promise( ( resolve, reject ) => {

					const timeout = setTimeout( () => reject( new Error( 'room connect timeout' ) ), 8000 );
					roomSocket.addEventListener( 'open', () => { clearTimeout( timeout ); resolve(); } );
					roomSocket.addEventListener( 'error', () => { clearTimeout( timeout ); reject( new Error( 'room connect failed' ) ); } );

				} );

			} catch ( e ) {

				socket.send( JSON.stringify( { error: 'Could not reach the room server.' } ) );
				Sys_Printf( 'Relay to room %s failed: %s\n', room.id, e.message );
				return;

			}

			roomSocket.addEventListener( 'message', ( ev ) => {

				if ( socket.readyState === WebSocket.OPEN ) socket.send( ev.data );

			} );
			roomSocket.addEventListener( 'close', () => { try { socket.close(); } catch ( e ) { /* ignore */ } } );
			roomSocket.addEventListener( 'error', () => { try { socket.close(); } catch ( e ) { /* ignore */ } } );

			phase = 'relay';
			joinedRoomId = room.id;
			RoomClients_Add( room.id, socket );
			socket.send( JSON.stringify( { ok: true } ) );
			Sys_Printf( 'Player %s joined room %s\n', session.username, room.id );
			return;

		}

		socket.send( JSON.stringify( { error: 'Unknown request type' } ) );

	} );

	socket.addEventListener( 'close', () => {

		if ( joinedRoomId !== null ) RoomClients_Remove( joinedRoomId, socket );
		if ( roomSocket ) { try { roomSocket.close(); } catch ( e ) { /* ignore */ } }

	} );

	socket.addEventListener( 'error', () => {

		if ( joinedRoomId !== null ) RoomClients_Remove( joinedRoomId, socket );
		if ( roomSocket ) { try { roomSocket.close(); } catch ( e ) { /* ignore */ } }

	} );

}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

async function requireLogin( req ) {

	const auth = req.headers.get( 'authorization' ) || '';
	const token = auth.startsWith( 'Bearer ' ) ? auth.slice( 7 ) : '';
	const session = await verifySession( token );

	if ( session === null ) return { error: _json( { error: 'Not logged in.' }, 401 ) };

	return { session };

}

async function requireAdmin( req ) {

	const auth = await requireLogin( req );
	if ( auth.error ) return auth;
	if ( auth.session.isAdmin !== true ) return { error: _json( { error: 'Admin access required.' }, 403 ) };

	return auth;

}

const USERNAME_PATTERN = /^[a-z0-9_-]{1,15}$/i; // matches Host_Name_f's 15-char in-game name limit
const MAP_CATEGORIES = [ 'vanilla', 'deathmatch', 'custom', 'mod' ];

/**
 * Builds/validates a mapdb.ts MapEntry from a request body. If `existing`
 * is given (PATCH), unset fields keep their previous value -- callers send
 * only what they changed.
 */
function mapEntryFromBody( body, existing ) {

	const base = existing || { title: '', category: 'custom' };

	const title = body.title !== undefined ? String( body.title ).trim() : base.title;
	if ( ! title ) return { error: 'Title is required.' };

	const category = body.category !== undefined ? String( body.category ) : base.category;
	if ( ! MAP_CATEGORIES.includes( category ) ) {

		return { error: 'Category must be one of: ' + MAP_CATEGORIES.join( ', ' ) + '.' };

	}

	const entry = { title, category };

	const blurb = body.blurb !== undefined ? String( body.blurb ).trim() : base.blurb;
	if ( blurb ) entry.blurb = blurb;

	const mod = body.mod !== undefined ? String( body.mod ).trim() : base.mod;
	if ( mod ) entry.mod = mod;

	const layersSource = body.layers !== undefined ? body.layers : base.layers;
	if ( Array.isArray( layersSource ) ) {

		const layers = layersSource.map( ( s ) => String( s ).trim() ).filter( ( s ) => s.length > 0 );
		if ( layers.length > 0 ) entry.layers = layers;

	} else if ( typeof layersSource === 'string' && layersSource.trim().length > 0 ) {

		entry.layers = layersSource.split( ',' ).map( ( s ) => s.trim() ).filter( ( s ) => s.length > 0 );

	}

	const episode = body.episode !== undefined ? body.episode : base.episode;
	if ( episode != null && episode !== '' ) entry.episode = Number( episode );

	const requiresRegistered = body.requiresRegistered !== undefined ? body.requiresRegistered : base.requiresRegistered;
	if ( requiresRegistered === true ) entry.requiresRegistered = true;

	const hidden = body.hidden !== undefined ? body.hidden : base.hidden;
	if ( hidden === true ) entry.hidden = true;

	return { value: entry };

}

async function handleAdminRequest( req, url ) {

	const auth = await requireAdmin( req );
	if ( auth.error ) return auth.error;

	const path = url.pathname;

	// --- Users ---------------------------------------------------------

	if ( req.method === 'GET' && path === '/admin/api/users' ) {

		return _json( { users: await listUsers() } );

	}

	if ( req.method === 'POST' && path === '/admin/api/users' ) {

		let body;
		try { body = await req.json(); } catch ( e ) { return _json( { error: 'Bad request.' }, 400 ); }

		const username = String( body.username || '' ).trim();
		const password = String( body.password || '' );
		const isAdmin = body.isAdmin === true;

		if ( ! USERNAME_PATTERN.test( username ) ) {

			return _json( { error: 'Username must be 1-15 characters (letters, numbers, - or _) -- Quake\'s in-game name limit.' }, 400 );

		}
		if ( password.length < 8 ) return _json( { error: 'Password must be at least 8 characters.' }, 400 );

		const existing = await listUsers();
		if ( existing.some( ( u ) => u.username === username.toLowerCase() ) ) {

			return _json( { error: 'That username already exists.' }, 409 );

		}

		await createUser( username, password, isAdmin );
		Sys_Printf( 'Admin %s created user %s\n', auth.session.username, username );
		return _json( { ok: true } );

	}

	const userMatch = path.match( /^\/admin\/api\/users\/([^/]+)$/ );
	if ( userMatch ) {

		const targetUsername = decodeURIComponent( userMatch[ 1 ] );

		if ( req.method === 'DELETE' ) {

			if ( targetUsername.toLowerCase() === auth.session.username.toLowerCase() ) {

				return _json( { error: 'You can\'t delete your own account.' }, 400 );

			}

			const removed = await deleteUser( targetUsername );
			if ( ! removed ) return _json( { error: 'No such user.' }, 404 );

			Sys_Printf( 'Admin %s deleted user %s\n', auth.session.username, targetUsername );
			return _json( { ok: true } );

		}

		if ( req.method === 'PATCH' ) {

			let body;
			try { body = await req.json(); } catch ( e ) { return _json( { error: 'Bad request.' }, 400 ); }

			if ( typeof body.password === 'string' && body.password.length > 0 ) {

				if ( body.password.length < 8 ) return _json( { error: 'Password must be at least 8 characters.' }, 400 );
				const ok = await setUserPassword( targetUsername, body.password );
				if ( ! ok ) return _json( { error: 'No such user.' }, 404 );

			}

			if ( typeof body.isAdmin === 'boolean' ) {

				if ( targetUsername.toLowerCase() === auth.session.username.toLowerCase() && body.isAdmin === false ) {

					return _json( { error: 'You can\'t remove your own admin access.' }, 400 );

				}

				const ok = await setUserAdmin( targetUsername, body.isAdmin );
				if ( ! ok ) return _json( { error: 'No such user.' }, 404 );

			}

			Sys_Printf( 'Admin %s updated user %s\n', auth.session.username, targetUsername );
			return _json( { ok: true } );

		}

	}

	// --- Maps ------------------------------------------------------------

	if ( req.method === 'GET' && path === '/admin/api/maps' ) {

		return _json( { maps: await listMaps( true ) } );

	}

	if ( req.method === 'POST' && path === '/admin/api/maps' ) {

		let body;
		try { body = await req.json(); } catch ( e ) { return _json( { error: 'Bad request.' }, 400 ); }

		const id = String( body.id || '' ).trim().toLowerCase();
		if ( ! /^[a-z0-9_]{1,32}$/.test( id ) ) {

			return _json( { error: 'Map ID must be 1-32 characters (letters, numbers, underscore) -- it has to match the actual map/bsp name.' }, 400 );

		}

		if ( await getMap( id ) !== null ) return _json( { error: 'A map with that ID already exists.' }, 409 );

		const entry = mapEntryFromBody( body );
		if ( entry.error ) return _json( { error: entry.error }, 400 );

		await setMap( id, entry.value );
		Sys_Printf( 'Admin %s added map %s\n', auth.session.username, id );
		return _json( { ok: true } );

	}

	const mapMatch = path.match( /^\/admin\/api\/maps\/([^/]+)$/ );
	if ( mapMatch ) {

		const id = decodeURIComponent( mapMatch[ 1 ] ).toLowerCase();

		if ( req.method === 'PATCH' ) {

			const existing = await getMap( id );
			if ( existing === null ) return _json( { error: 'No such map.' }, 404 );

			let body;
			try { body = await req.json(); } catch ( e ) { return _json( { error: 'Bad request.' }, 400 ); }

			const entry = mapEntryFromBody( body, existing );
			if ( entry.error ) return _json( { error: entry.error }, 400 );

			await setMap( id, entry.value );
			Sys_Printf( 'Admin %s updated map %s\n', auth.session.username, id );
			return _json( { ok: true } );

		}

		if ( req.method === 'DELETE' ) {

			const removed = await deleteMap( id );
			if ( ! removed ) return _json( { error: 'No such map.' }, 404 );

			Sys_Printf( 'Admin %s deleted map %s\n', auth.session.username, id );
			return _json( { ok: true } );

		}

	}

	// --- Rooms -----------------------------------------------------------

	if ( req.method === 'GET' && path === '/admin/api/rooms' ) {

		return _json( { rooms: RoomManager_ListRooms() } );

	}

	const roomMatch = path.match( /^\/admin\/api\/rooms\/([^/]+)$/ );
	if ( roomMatch && req.method === 'DELETE' ) {

		const roomId = decodeURIComponent( roomMatch[ 1 ] ).toUpperCase();

		if ( roomId === HUB_ROOM_ID ) {

			return _json( { error: 'Can\'t terminate the hub -- it\'ll only come back empty on the next lobby restart.' }, 400 );

		}

		const removed = RoomManager_TerminateRoom( roomId );
		if ( ! removed ) return _json( { error: 'No such room.' }, 404 );

		Sys_Printf( 'Admin %s terminated room %s\n', auth.session.username, roomId );
		return _json( { ok: true } );

	}

	return _json( { error: 'Not found.' }, 404 );

}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function buildHandler() {

	return async ( req, info ) => {

		const address = info.remoteAddr.hostname + ':' + info.remoteAddr.port;
		const url = new URL( req.url );

		if ( req.method === 'OPTIONS' ) {

			return new Response( null, { status: 204, headers: _corsHeaders() } );

		}

		if ( req.method === 'POST' && url.pathname === '/login' ) {

			return await handleLogin( req, info.remoteAddr.hostname );

		}

		if ( url.pathname.startsWith( '/admin/api/' ) ) {

			return await handleAdminRequest( req, url );

		}

		if ( req.method === 'GET' && url.pathname === '/api/mapdb' ) {

			const auth = await requireLogin( req );
			if ( auth.error ) return auth.error;

			return _json( { maps: await listMaps( false ) } );

		}

		if ( req.headers.get( 'upgrade' ) === 'websocket' && url.pathname === '/ws' ) {

			const { socket, response } = Deno.upgradeWebSocket( req );
			handleWsConnection( socket, address );
			return response;

		}

		return new Response( 'Quake with Friends lobby server\n', { status: 200 } );

	};

}

/**
 * Start the lobby server
 */
async function startServer() {
	Sys_Printf( '========================================\n' );
	Sys_Printf( 'Quake with Friends Lobby Server v2.0 (WebSocket)\n' );
	Sys_Printf( '========================================\n\n' );

	if ( ! Deno.env.get( 'THREE_QUAKE_SECRET' ) ) {

		Sys_Printf( 'WARNING: THREE_QUAKE_SECRET is not set -- room processes will accept\n' );
		Sys_Printf( 'any connection on their loopback port without verifying it came\n' );
		Sys_Printf( 'through this lobby. Set it (see server/README.md) to close that gap.\n' );

	}

	// Configure room manager
	RoomManager_SetConfig( {
		pakPath: CONFIG.pakPath,
	} );

	const serveOptions = { port: CONFIG.port, hostname: '0.0.0.0' };

	if ( CONFIG.certFile && CONFIG.keyFile ) {

		serveOptions.cert = await Deno.readTextFile( CONFIG.certFile );
		serveOptions.key = await Deno.readTextFile( CONFIG.keyFile );
		Sys_Printf( 'Lobby server listening on port %d (HTTPS/WSS)\n', CONFIG.port );

	} else {

		Sys_Printf( 'Lobby server listening on port %d (HTTP/WS -- no -cert/-key given)\n', CONFIG.port );
		Sys_Printf( 'This is fine behind a reverse proxy/tunnel that terminates TLS itself.\n' );

	}

	Deno.serve( serveOptions, buildHandler() );

	// Persistent hub room (map/mod chosen in src/hub_config.js), always
	// running, exempt from idle cleanup, so there's always somewhere for
	// players to land and meet before starting a match at the kiosk.
	const hub = await RoomManager_CreateRoom( {
		map: HUB_MAP,
		mod: HUB_MOD,
		maxPlayers: HUB_MAX_PLAYERS,
		hostName: 'Hub',
		specificId: HUB_ROOM_ID,
		persistent: true,
	} );
	if ( hub !== null ) {

		Sys_Printf( 'Hub room ready: %s on port %d\n', hub.id, hub.port );

	} else {

		Sys_Printf( 'WARNING: failed to create hub room\n' );

	}

	// Start cleanup timer (every 5 minutes)
	setInterval( () => {
		const unhealthy = RoomManager_CleanupUnhealthyRooms();
		if ( unhealthy > 0 ) {
			Sys_Printf( 'Cleaned up %d unhealthy rooms\n', unhealthy );
		}

		const cleaned = RoomManager_CleanupIdleRooms();
		if ( cleaned > 0 ) {
			Sys_Printf( 'Cleaned up %d idle rooms\n', cleaned );
		}
	}, 5 * 60 * 1000 );

}

/**
 * Main entry point
 */
async function main() {
	parseArgs();

	// Handle shutdown
	Deno.addSignalListener( 'SIGTERM', () => {
		Sys_Printf( 'Received SIGTERM, shutting down...\n' );
		RoomManager_ShutdownAll();
		Deno.exit( 0 );
	} );

	try {
		await startServer();
	} catch ( error ) {
		console.error( 'Fatal error:', error );
		Deno.exit( 1 );
	}
}

main();
