// Client-side session helper: talks to the lobby's HTTPS /login endpoint,
// stores the resulting token, and gates pages that require a login.

const STORAGE_KEY = 'tq_session';

export function getSession() {

	try {

		const raw = localStorage.getItem( STORAGE_KEY );
		if ( ! raw ) return null;

		const session = JSON.parse( raw );
		if ( ! session || typeof session.token !== 'string' || ! session.token ) return null;

		return session;

	} catch ( e ) {

		return null;

	}

}

export function setSession( token, username, isAdmin ) {

	localStorage.setItem( STORAGE_KEY, JSON.stringify( { token, username, isAdmin: isAdmin === true } ) );

}

/**
 * Returns the lobby's base http(s) URL, matching the page's own protocol
 * (a local http dev page talks plain http to the lobby, a deployed https
 * page talks https).
 */
export function lobbyBaseUrl() {

	const lobby = ( window.THREE_QUAKE_SERVER && window.THREE_QUAKE_SERVER.lobby ) || 'localhost:4433';
	const scheme = location.protocol === 'https:' ? 'https://' : 'http://';
	return scheme + lobby;

}

/**
 * fetch() wrapper that attaches the current session's bearer token. Throws
 * if there's no session at all (caller should have gated with
 * requireSession first).
 */
export async function authedFetch( path, options ) {

	const session = getSession();
	if ( session === null ) throw new Error( 'Not logged in.' );

	const opts = Object.assign( {}, options );
	opts.headers = Object.assign( { Authorization: 'Bearer ' + session.token }, options && options.headers );

	return await fetch( lobbyBaseUrl() + path, opts );

}

export function clearSession() {

	localStorage.removeItem( STORAGE_KEY );

}

/**
 * Redirects to login.html if there's no stored session. Returns the session
 * if present. Doesn't validate the token against the server -- an expired
 * or revoked token just fails later when it's actually used (room join),
 * which redirects back to login at that point too.
 */
export function requireSession() {

	const session = getSession();
	if ( session === null ) {

		const next = encodeURIComponent( location.pathname + location.search );
		location.href = 'login.html?next=' + next;
		return null;

	}

	return session;

}

/**
 * POSTs credentials to the lobby's login endpoint. Throws with a
 * user-facing message on failure.
 */
export async function login( username, password ) {

	const loginUrl = lobbyBaseUrl() + '/login';

	let response;
	try {

		response = await fetch( loginUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { username, password } ),
		} );

	} catch ( e ) {

		throw new Error( 'Could not reach the server (' + loginUrl + '). Is it running?' );

	}

	let body;
	try {

		body = await response.json();

	} catch ( e ) {

		throw new Error( 'Unexpected response from server.' );

	}

	if ( ! response.ok ) {

		throw new Error( body.error || 'Login failed.' );

	}

	setSession( body.token, body.username, body.isAdmin );
	return body;

}

export function logout() {

	clearSession();
	location.href = 'login.html';

}

/**
 * Like requireSession, but also redirects (to index.html) if the session
 * isn't an admin. Actual authorization is still enforced server-side on
 * every admin/api/* call -- this is just so non-admins don't see the page
 * flash before an API call rejects them.
 */
export function requireAdminSession() {

	const session = requireSession();
	if ( session === null ) return null;

	if ( session.isAdmin !== true ) {

		location.href = 'index.html';
		return null;

	}

	return session;

}
