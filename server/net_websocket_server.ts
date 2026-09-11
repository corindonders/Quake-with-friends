// WebSocket server driver for Deno room processes.
//
// Unlike the old WebTransport server driver, this listens on
// 127.0.0.1 only -- room processes are never reachable from outside the
// machine. The lobby process is the only client: once it accepts a
// player's connection and they join this room, the lobby opens one of
// these loopback WebSocket connections and transparently relays binary
// frames both ways. No TLS, no lobby protocol, no direct-mode handling
// needed here at all -- that's all owned by the lobby now.
//
// Wire format matches src/net_websocket.js: each binary message is
// [reliable:1][quake_payload...]. WebSocket already gives ordered,
// reliable, framed delivery, so none of the old driver's manual sequence
// numbers/acks/magic-byte headers are needed.

import { Sys_Printf } from './sys_server.ts';
import { net_message } from '../src/net.js';
import { SZ_Clear, SZ_Write } from '../src/common.js';
import { verifyRoomTicket } from './auth.ts';

export interface ClientConnection {
	id: number;
	socket: WebSocket;
	pendingMessages: Array<{ reliable: boolean; data: Uint8Array }>;
	connected: boolean;
	address: string;
}

// Socket structure compatible with Quake's qsocket_t
export interface QSocket {
	next: QSocket | null;
	connecttime: number;
	lastMessageTime: number;
	lastSendTime: number;
	disconnected: boolean;
	canSend: boolean;
	sendNext: boolean;
	driver: number;
	landriver: number;
	socket: number;
	driverdata: ClientConnection | null;
	ackSequence: number;
	sendSequence: number;
	unreliableSendSequence: number;
	sendMessageLength: number;
	sendMessage: Uint8Array;
	receiveSequence: number;
	unreliableReceiveSequence: number;
	receiveMessageLength: number;
	receiveMessage: Uint8Array;
	addr: unknown;
	address: string;
}

// Deprecated no-ops kept so game_server.js doesn't need special-casing per driver.
export function WS_SetDirectMode( _enabled: boolean ): void {}
export function WS_SetMapCallbacks(
	_changeMap: ( mapName: string ) => Promise<void>,
	_getCurrentMap: () => string,
): void {}
export function WS_SetMaxClientsCallback( _setMaxClients: ( maxClients: number ) => void ): void {}

let serverPort = 4433;
let serverRoomId: string | null = null;

let _NET_NewQSocket: ( () => QSocket | null ) | null = null;
let _NET_FreeQSocket: ( ( sock: QSocket ) => void ) | null = null;

export function WS_SetSocketAllocator( allocator: () => QSocket | null ): void {
	_NET_NewQSocket = allocator;
}

export function WS_SetSocketFreer( freer: ( sock: QSocket ) => void ): void {
	_NET_FreeQSocket = freer;
}

export function WS_SetConfig( config: { port?: number; roomId?: string } ): void {
	if ( config.port != null ) serverPort = config.port;
	if ( config.roomId != null ) serverRoomId = config.roomId;
}

let net_driverlevel = 0;
export function WS_SetDriverLevel( level: number ): void {
	net_driverlevel = level;
}

const pendingConnections: QSocket[] = [];
const socketsByQSocket = new Map<QSocket, ClientConnection>();
let nextConnectionId = 1;
let httpServer: Deno.HttpServer | null = null;

export function WS_Init(): number {
	Sys_Printf( 'WebSocket server driver initialized\n' );
	return 0;
}

export function WS_Shutdown(): void {
	for ( const conn of socketsByQSocket.values() ) {
		try { conn.socket.close(); } catch { /* ignore */ }
	}
	socketsByQSocket.clear();
	if ( httpServer != null ) {
		httpServer.shutdown().catch( () => {} );
		httpServer = null;
	}
}

export async function WS_Listen( state: boolean ): Promise<void> {
	if ( ! state ) {
		if ( httpServer != null ) {
			await httpServer.shutdown();
			httpServer = null;
		}
		return;
	}

	if ( httpServer != null ) return;

	httpServer = Deno.serve(
		{ hostname: '127.0.0.1', port: serverPort, onListen: () => {} },
		async ( req ) => {

			if ( req.headers.get( 'upgrade' ) !== 'websocket' ) {
				return new Response( 'Quake with Friends room process\n', { status: 200 } );
			}

			// Loopback-only doesn't mean "safe" -- anything else on the same
			// machine (or in the same container) could still hit this port
			// directly. When THREE_QUAKE_SECRET is configured, require the
			// short-lived ticket the lobby signs at join time (see
			// createRoomTicket in lobby_server.js) and reject anything else.
			// Left open (with a warning) when no secret is configured, so an
			// unconfigured deployment doesn't silently lock every player out.
			if ( Deno.env.get( 'THREE_QUAKE_SECRET' ) ) {

				const ticket = new URL( req.url ).searchParams.get( 'ticket' );
				const claim = ticket != null ? await verifyRoomTicket( ticket ) : null;

				if ( claim === null || ( serverRoomId != null && claim.roomId !== serverRoomId ) ) {

					Sys_Printf( 'Rejected unauthenticated connection (missing/invalid/mismatched room ticket)\n' );
					return new Response( 'Unauthorized\n', { status: 401 } );

				}

			}

			const { socket, response } = Deno.upgradeWebSocket( req );
			const address = '127.0.0.1';

			socket.binaryType = 'arraybuffer';

			const conn: ClientConnection = {
				id: nextConnectionId ++,
				socket,
				pendingMessages: [],
				connected: true,
				address,
			};

			const qsock = _NET_NewQSocket ? _NET_NewQSocket() : null;
			if ( qsock == null ) {
				Sys_Printf( 'WS_Listen: no free sockets, rejecting connection\n' );
				try { socket.close(); } catch { /* ignore */ }
				return response;
			}

			qsock.driver = net_driverlevel;
			qsock.driverdata = conn;
			qsock.address = address;
			socketsByQSocket.set( qsock, conn );

			socket.addEventListener( 'message', ( event ) => {

				if ( typeof event.data === 'string' ) return; // no control protocol at this layer

				const bytes = new Uint8Array( event.data as ArrayBuffer );
				if ( bytes.length < 1 ) return;

				conn.pendingMessages.push( { reliable: bytes[ 0 ] === 1, data: bytes.subarray( 1 ) } );

			} );

			socket.addEventListener( 'close', () => {

				conn.connected = false;

			} );

			socket.addEventListener( 'error', () => {

				conn.connected = false;

			} );

			pendingConnections.push( qsock );
			Sys_Printf( 'Connection from %s\n', address );

			return response;

		}
	);

	Sys_Printf( 'WebSocket server listening on port %d\n', serverPort );

}

export function WS_SearchForHosts( _xmit: boolean ): void {}

export function WS_CheckNewConnections(): QSocket | null {
	if ( pendingConnections.length === 0 ) return null;
	return pendingConnections.shift() as QSocket;
}

export function WS_QGetMessage( sock: QSocket ): number {

	const conn = sock.driverdata;
	if ( conn == null ) return - 1;

	if ( ! conn.connected && conn.pendingMessages.length === 0 ) return - 1;

	if ( conn.pendingMessages.length > 0 ) {

		let msg = conn.pendingMessages.shift()!;

		if ( ! msg.reliable ) {

			while ( conn.pendingMessages.length > 0 && ! conn.pendingMessages[ 0 ].reliable ) {
				msg = conn.pendingMessages.shift()!;
			}

		}

		SZ_Clear( net_message );
		SZ_Write( net_message, msg.data, msg.data.length );

		sock.lastMessageTime = Date.now() / 1000;

		return msg.reliable ? 1 : 2;

	}

	if ( conn.connected ) return 0;

	return - 1;

}

function sendFrame( conn: ClientConnection | null, data: Uint8Array, cursize: number, reliable: boolean ): number {

	if ( conn == null || ! conn.connected ) return - 1;
	if ( conn.socket.readyState !== WebSocket.OPEN ) return - 1;

	const frame = new Uint8Array( 1 + cursize );
	frame[ 0 ] = reliable ? 1 : 0;
	frame.set( data.subarray( 0, cursize ), 1 );

	try {
		conn.socket.send( frame );
		return 1;
	} catch ( _e ) {
		return - 1;
	}

}

export function WS_QSendMessage( sock: QSocket, data: { data: Uint8Array; cursize: number } ): number {
	return sendFrame( sock.driverdata, data.data, data.cursize, true );
}

export function WS_SendUnreliableMessage( sock: QSocket, data: { data: Uint8Array; cursize: number } ): number {
	return sendFrame( sock.driverdata, data.data, data.cursize, false );
}

export function WS_CanSendMessage( sock: QSocket ): boolean {
	const conn = sock.driverdata;
	return conn != null && conn.connected && conn.socket.readyState === WebSocket.OPEN;
}

export function WS_CanSendUnreliableMessage( sock: QSocket ): boolean {
	return WS_CanSendMessage( sock );
}

export function WS_Close( sock: QSocket ): void {
	const conn = sock.driverdata;
	if ( conn == null ) return;
	conn.connected = false;
	try { conn.socket.close(); } catch { /* ignore */ }
	socketsByQSocket.delete( sock );
}
