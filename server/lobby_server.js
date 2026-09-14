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

/*
=============================================================================

Hub presence -- who is sitting on the 2D hub page (hub.html) right now.

The open socket *is* the presence: a player appears on everyone's roster
when their page connects and disappears when it closes, so there's no
heartbeat or timeout to get wrong. Keyed by socket rather than username
because one account can have the page open twice (two tabs, phone +
laptop); the roster itself is deduped so a person still shows up once.

Separate from roomClients above: that tracks connections relayed into an
actual running game room, this tracks people on the web page.
=============================================================================
*/

const hubPresence = new Map(); // WebSocket -> { username, isAdmin, joinedAt }

function HubPresence_Roster() {

	const byUser = new Map();
	for ( const entry of hubPresence.values() ) {

		const seen = byUser.get( entry.username );
		if ( seen === undefined || entry.joinedAt < seen.joinedAt ) byUser.set( entry.username, entry );

	}

	return [ ...byUser.values() ]
		.sort( ( a, b ) => a.joinedAt - b.joinedAt )
		.map( ( e ) => ( { username: e.username, isAdmin: e.isAdmin } ) );

}

function HubPresence_Broadcast() {

	const payload = JSON.stringify( { type: 'presence', players: HubPresence_Roster() } );
	for ( const socket of hubPresence.keys() ) {

		if ( socket.readyState !== WebSocket.OPEN ) continue;
		try { socket.send( payload ); } catch ( e ) { /* ignore */ }

	}

}

function HubPresence_Add( socket, session ) {

	hubPresence.set( socket, {
		username: session.username,
		isAdmin: session.isAdmin === true,
		joinedAt: Date.now(),
	} );

	HubPresence_Broadcast();

}

function HubPresence_Remove( socket ) {

	if ( ! hubPresence.delete( socket ) ) return;
	HubPresence_Broadcast();

}

/**
 * Tell everyone on the hub page right now to navigate into the room that
 * was just created for them -- the "host starts for all" moment. Each
 * hub.html client turns this into a fresh navigation to
 * `index.html?room=...&map=...`; that page load is itself what leaves the
 * hub (closing this socket), so there's nothing to clean up here. mapId
 * rides along too -- it's a brand new page, not the same running client the
 * old in-world kiosk broadcast reached, so it can't already know which
 * mod dirs the level needs without being told again.
 */
function HubPresence_BroadcastStart( roomId, mapId ) {

	const payload = JSON.stringify( { type: 'start', roomId, mapId } );
	for ( const socket of hubPresence.keys() ) {

		if ( socket.readyState !== WebSocket.OPEN ) continue;
		try { socket.send( payload ); } catch ( e ) { /* ignore */ }

	}

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

	// A valid-looking room ID that doesn't exist (e.g. an expired shared
	// link) gets a fresh default room rather than a dead end.
	if ( room === null && ROOM_ID_PATTERN.test( roomId ) ) {

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

// Only vanilla episode maps ("vanilla") are single-player-shaped by design
// (scripted intro/outro, not built with extra players in mind); everything
// else in the catalog -- mod campaigns, standalone customs -- is normal
// Quake level geometry that coop already just works on. "deathmatch" maps
// are the one category that should never come up as coop: no monsters, no
// end trigger, built purely for players fighting each other.
//
// No mode picker in hub.html on purpose (see DEVELOPMENT.md): the room size
// already comes from how many people are in the hub when Start is pressed,
// and the mode comes from what kind of map got picked. One less decision
// for the group to agree on.
function hubModeForCategory( category ) {

	return category === 'deathmatch' ? 'ffa' : 'coop';

}

/**
 * hub.html's "Start": everyone currently on the hub page picks this up as
 * one group, sized to however many are there when it's pressed. Creates a
 * fresh room (never reuses one -- two different groups starting the same
 * map minutes apart shouldn't land in each other's leftover match) and
 * tells every hub page to navigate there together.
 */
async function handleHubStart( mapId, playerCount ) {

	const normalizedMapId = String( mapId || '' ).toLowerCase().replace( /[^a-z0-9_]/g, '' );
	if ( normalizedMapId.length === 0 ) return { error: 'Pick a map first.' };

	const entry = await getMap( normalizedMapId );
	if ( entry === null ) return { error: 'No such map.' };

	const mode = hubModeForCategory( entry.category );
	const maxPlayers = Math.max( playerCount, 1 );

	const result = await RoomManager_CreateRoom( {
		map: normalizedMapId,
		mod: ( entry.layers || [] ).join( ',' ),
		maxPlayers,
		hostName: 'Hub',
		mode,
	} );

	if ( result === null ) return { error: 'Server room limit reached. Try again later.' };

	Sys_Printf( 'Hub start: %s (%s) -> room %s for %d player(s)\n',
		normalizedMapId, mode, result.id, maxPlayers );

	return { ok: true, roomId: result.id, mapId: normalizedMapId };

}

function handleWsConnection( socket, address ) {

	let phase = 'control'; // 'control' (JSON lobby requests) | 'relay' (raw game bytes)
	let roomSocket = null;
	let joinedRoomId = null;

	socket.addEventListener( 'message', async ( event ) => {

		if ( phase === 'relay' ) {

			// A joined connection is raw game data only now -- "start
			// together" is decided on hub.html before this join ever
			// happens, so a stray text frame here is unexpected.
			if ( typeof event.data === 'string' ) return;

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

		// hub.html holds this socket open for as long as its page is open --
		// see the HubPresence helpers above. Nothing further is sent on it;
		// the roster comes back down as unsolicited 'presence' broadcasts
		// whenever anyone arrives or leaves.
		if ( msg.type === 'presence' ) {

			HubPresence_Add( socket, session );
			Sys_Printf( '%s is in the hub (%d present)\n', session.username, hubPresence.size );
			return;

		}

		// Anyone on the hub page can hit Start -- host-picks-for-everyone,
		// same as the old in-world kiosk, just triggered from the page
		// instead of a worldspace panel. Sized to (and only meaningful for)
		// whoever is present on hub.html *right now*; latecomers after this
		// fires just missed that group and see an empty hub again once
		// everyone else's page has navigated away.
		if ( msg.type === 'start' ) {

			const result = await handleHubStart( msg.mapId, hubPresence.size );

			if ( result.error ) {

				socket.send( JSON.stringify( { type: 'start_failed', error: result.error } ) );
				return;

			}

			HubPresence_BroadcastStart( result.roomId, result.mapId );
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
		HubPresence_Remove( socket );
		if ( roomSocket ) { try { roomSocket.close(); } catch ( e ) { /* ignore */ } }

	} );

	socket.addEventListener( 'error', () => {

		if ( joinedRoomId !== null ) RoomClients_Remove( joinedRoomId, socket );
		HubPresence_Remove( socket );
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

	// No persistent hub room to bootstrap -- the hub is hub.html now, a
	// plain page, not a running game room (see HubPresence above).

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
