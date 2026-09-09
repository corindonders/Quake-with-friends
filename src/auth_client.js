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

export function setSession( token, username ) {

	localStorage.setItem( STORAGE_KEY, JSON.stringify( { token, username } ) );

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

	const lobby = ( window.THREE_QUAKE_SERVER && window.THREE_QUAKE_SERVER.lobby ) || 'localhost:4433';
	// Match the page's own protocol: an http (local dev) page talks plain
	// http to the lobby, an https (deployed) page talks https.
	const scheme = location.protocol === 'https:' ? 'https://' : 'http://';
	const loginUrl = scheme + lobby + '/login';

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

	setSession( body.token, body.username );
	return body;

}

export function logout() {

	clearSession();
	location.href = 'login.html';

}
