/// <reference lib="deno.unstable" />
// Three-Quake auth: admin-managed accounts, password hashing, sessions.
// Storage: Deno KV (local file-backed, no external DB needed).
//
// Threat model: a small trusted friend group. This is intentionally simple --
// no self-signup, no password reset flow. The admin creates accounts with
// manage_users.ts and shares credentials out-of-band (e.g. Discord DM).

// Explicit path: Deno.openKv() with no path resolves relative to whichever
// deno.json gets discovered for the entry script, which differs between
// e.g. `deno run server/manage_users.ts` (finds server/deno.json) and
// `deno run server/lobby_server.js` (same) vs anything run from elsewhere --
// pin it so every process shares the same database regardless of cwd.
const kvPath = decodeURIComponent( new URL( './data/users.db', import.meta.url ).pathname ).replace( /^\/([A-Za-z]:)/, '$1' );
await Deno.mkdir( new URL( './data', import.meta.url ), { recursive: true } );
const kv = await Deno.openKv( kvPath );

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PBKDF2_ITERATIONS = 210_000;

function toBase64( bytes: Uint8Array ): string {
	let bin = '';
	for ( const b of bytes ) bin += String.fromCharCode( b );
	return btoa( bin );
}

function fromBase64( s: string ): Uint8Array {
	const bin = atob( s );
	const bytes = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) bytes[ i ] = bin.charCodeAt( i );
	return bytes;
}

async function hashPassword( password: string, salt: Uint8Array ): Promise<Uint8Array> {

	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode( password ),
		'PBKDF2',
		false,
		[ 'deriveBits' ]
	);

	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		keyMaterial,
		256
	);

	return new Uint8Array( bits );

}

function timingSafeEqual( a: Uint8Array, b: Uint8Array ): boolean {

	if ( a.length !== b.length ) return false;
	let diff = 0;
	for ( let i = 0; i < a.length; i ++ ) diff |= a[ i ] ^ b[ i ];
	return diff === 0;

}

interface UserRecord {
	username: string;
	salt: string; // base64
	hash: string; // base64
	isAdmin: boolean;
	createdAt: number;
}

/**
 * Create or overwrite a user account. Returns the stored record (without secrets).
 */
export async function createUser( username: string, password: string, isAdmin = false ): Promise<void> {

	const salt = crypto.getRandomValues( new Uint8Array( 16 ) );
	const hash = await hashPassword( password, salt );

	const record: UserRecord = {
		username: username.toLowerCase(),
		salt: toBase64( salt ),
		hash: toBase64( hash ),
		isAdmin,
		createdAt: Date.now(),
	};

	await kv.set( [ 'users', record.username ], record );

}

export async function deleteUser( username: string ): Promise<boolean> {

	const key = [ 'users', username.toLowerCase() ];
	const existing = await kv.get( key );
	if ( existing.value == null ) return false;
	await kv.delete( key );
	return true;

}

export async function setUserPassword( username: string, password: string ): Promise<boolean> {

	const key = [ 'users', username.toLowerCase() ];
	const existing = await kv.get<UserRecord>( key );
	if ( existing.value == null ) return false;

	const salt = crypto.getRandomValues( new Uint8Array( 16 ) );
	const hash = await hashPassword( password, salt );

	await kv.set( key, { ...existing.value, salt: toBase64( salt ), hash: toBase64( hash ) } );
	return true;

}

export async function setUserAdmin( username: string, isAdmin: boolean ): Promise<boolean> {

	const key = [ 'users', username.toLowerCase() ];
	const existing = await kv.get<UserRecord>( key );
	if ( existing.value == null ) return false;

	await kv.set( key, { ...existing.value, isAdmin } );
	return true;

}

export async function listUsers(): Promise<{ username: string; isAdmin: boolean; createdAt: number }[]> {

	const out = [];
	for await ( const entry of kv.list<UserRecord>( { prefix: [ 'users' ] } ) ) {

		out.push( { username: entry.value.username, isAdmin: entry.value.isAdmin, createdAt: entry.value.createdAt } );

	}

	return out;

}

/**
 * Verify a username/password pair. Returns the user record on success, null on failure.
 * Always does a full hash comparison (even for unknown users, against a dummy salt)
 * to avoid trivially timing-leaking which usernames exist.
 */
export async function verifyPassword( username: string, password: string ): Promise<{ username: string; isAdmin: boolean } | null> {

	const key = [ 'users', username.toLowerCase() ];
	const entry = await kv.get<UserRecord>( key );

	const salt = entry.value ? fromBase64( entry.value.salt ) : crypto.getRandomValues( new Uint8Array( 16 ) );
	const computed = await hashPassword( password, salt );

	if ( entry.value == null ) return null;

	const expected = fromBase64( entry.value.hash );
	if ( ! timingSafeEqual( computed, expected ) ) return null;

	return { username: entry.value.username, isAdmin: entry.value.isAdmin };

}

interface SessionRecord {
	username: string;
	isAdmin: boolean;
	expiresAt: number;
}

function generateToken(): string {

	const bytes = crypto.getRandomValues( new Uint8Array( 32 ) );
	return toBase64( bytes ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

}

export async function createSession( username: string, isAdmin: boolean ): Promise<string> {

	const token = generateToken();
	const record: SessionRecord = { username, isAdmin, expiresAt: Date.now() + SESSION_TTL_MS };
	await kv.set( [ 'sessions', token ], record, { expireIn: SESSION_TTL_MS } );
	return token;

}

export async function verifySession( token: string ): Promise<{ username: string; isAdmin: boolean } | null> {

	if ( ! token || token.length < 16 ) return null;

	const entry = await kv.get<SessionRecord>( [ 'sessions', token ] );
	if ( entry.value == null ) return null;
	if ( entry.value.expiresAt < Date.now() ) return null;

	return { username: entry.value.username, isAdmin: entry.value.isAdmin };

}

export async function revokeSession( token: string ): Promise<void> {

	await kv.delete( [ 'sessions', token ] );

}

// ---------------------------------------------------------------------------
// Room tickets: short-lived, HMAC-signed proof that a session was valid at
// room-join time. Minted by lobby_server.js on join, verified by room
// processes in net_websocket_server.ts's upgrade handler -- see
// server/README.md security notes.
// ---------------------------------------------------------------------------

async function getHmacKey(): Promise<CryptoKey> {

	const secret = Deno.env.get( 'THREE_QUAKE_SECRET' );
	if ( ! secret ) throw new Error( 'THREE_QUAKE_SECRET env var is not set' );

	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode( secret ),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		[ 'sign', 'verify' ]
	);

}

export async function createRoomTicket( username: string, roomId: string ): Promise<string> {

	const key = await getHmacKey();
	const payload = JSON.stringify( { username, roomId, exp: Date.now() + 60_000 } );
	const payloadB64 = toBase64( new TextEncoder().encode( payload ) );
	const sig = await crypto.subtle.sign( 'HMAC', key, new TextEncoder().encode( payloadB64 ) );
	return payloadB64 + '.' + toBase64( new Uint8Array( sig ) );

}

export async function verifyRoomTicket( ticket: string ): Promise<{ username: string; roomId: string } | null> {

	try {

		const [ payloadB64, sigB64 ] = ticket.split( '.' );
		if ( ! payloadB64 || ! sigB64 ) return null;

		const key = await getHmacKey();
		const valid = await crypto.subtle.verify(
			'HMAC', key, fromBase64( sigB64 ) as BufferSource, new TextEncoder().encode( payloadB64 )
		);
		if ( ! valid ) return null;

		const payload = JSON.parse( new TextDecoder().decode( fromBase64( payloadB64 ) ) );
		if ( payload.exp < Date.now() ) return null;

		return { username: payload.username, roomId: payload.roomId };

	} catch ( e ) {

		return null;

	}

}
