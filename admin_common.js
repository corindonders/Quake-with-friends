// Shared helpers for the admin_*.html pages (Users/Maps/Rooms/dashboard) --
// each page imports what it needs rather than duplicating this per page.

import { authedFetch } from './src/auth_client.js';

export async function api( path, options ) {

	const res = await authedFetch( path, options );
	let body = null;
	try { body = await res.json(); } catch ( e ) { /* empty body */ }

	if ( ! res.ok ) throw new Error( ( body && body.error ) || ( 'Request failed (' + res.status + ')' ) );
	return body;

}

export function showStatus( text, isError ) {

	const el = document.getElementById( 'status' );
	if ( ! el ) return;
	el.textContent = text;
	el.className = isError ? 'error' : 'ok';
	el.style.display = 'block';
	clearTimeout( showStatus._t );
	showStatus._t = setTimeout( () => { el.style.display = 'none'; }, 4000 );

}

export function escapeHTML( s ) {

	const div = document.createElement( 'div' );
	div.textContent = String( s == null ? '' : s );
	return div.innerHTML;

}

export function fmtDate( ms ) {

	if ( ! ms ) return '—';
	return new Date( ms ).toLocaleString();

}
