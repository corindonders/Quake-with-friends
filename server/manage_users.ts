// Admin CLI for managing Three-Quake accounts.
//
// Usage:
//   deno run --allow-read --allow-write --unstable-kv server/manage_users.ts add <username> <password> [--admin]
//   deno run --allow-read --allow-write --unstable-kv server/manage_users.ts remove <username>
//   deno run --allow-read --allow-write --unstable-kv server/manage_users.ts list
//
// Run this on the same machine (and from the same working directory) as the
// lobby server, so it's reading/writing the same local Deno KV database.

import { createUser, deleteUser, listUsers } from './auth.ts';

const [ cmd, ...rest ] = Deno.args;

function fail( msg: string ): never {

	console.error( msg );
	Deno.exit( 1 );

}

switch ( cmd ) {

	case 'add': {

		const [ username, password ] = rest;
		if ( ! username || ! password ) fail( 'Usage: manage_users.ts add <username> <password> [--admin]' );
		if ( password.length < 8 ) fail( 'Password must be at least 8 characters.' );

		const isAdmin = rest.includes( '--admin' );
		await createUser( username, password, isAdmin );
		console.log( `Created user "${ username.toLowerCase() }"${ isAdmin ? ' (admin)' : '' }.` );
		break;

	}

	case 'remove': {

		const [ username ] = rest;
		if ( ! username ) fail( 'Usage: manage_users.ts remove <username>' );

		const removed = await deleteUser( username );
		console.log( removed ? `Removed user "${ username.toLowerCase() }".` : `No such user "${ username.toLowerCase() }".` );
		break;

	}

	case 'list': {

		const users = await listUsers();
		if ( users.length === 0 ) {

			console.log( 'No users yet.' );

		} else {

			for ( const u of users ) {

				console.log( `${ u.username }${ u.isAdmin ? ' (admin)' : '' } — created ${ new Date( u.createdAt ).toISOString() }` );

			}

		}
		break;

	}

	default:
		fail( 'Usage: manage_users.ts <add|remove|list> ...' );

}

Deno.exit( 0 );
