/// <reference lib="deno.unstable" />
// Server-managed map catalog: what maps.html and the in-hub Travel picker
// show players, editable by admins from admin.html instead of hand-editing
// the repo's mapdb.json. Backed by Deno KV so edits take effect immediately
// without redeploying the client.
//
// Seeded once from the repo's root mapdb.json (read relative to this file's
// location, i.e. ../mapdb.json) the first time the store is empty -- after
// that, KV is the source of truth and the static file is only a fallback
// (e.g. a machine that's never run the lobby yet).

const kvPath = decodeURIComponent( new URL( './data/mapdb.db', import.meta.url ).pathname )
	.replace( /^\/([A-Za-z]:)/, '$1' );
await Deno.mkdir( new URL( './data', import.meta.url ), { recursive: true } );
const kv = await Deno.openKv( kvPath );

export interface MapEntry {
	title: string;
	category: string; // 'vanilla' | 'deathmatch' | 'custom' | 'mod' | ...
	blurb?: string;
	episode?: number;
	requiresRegistered?: boolean;
	mod?: string; // display name of the mod this map needs, if any
	layers?: string[]; // mod dirs to layer in, e.g. [ "mods/copper" ]
	hidden?: boolean; // excluded from the player-facing catalog when true
}

function key( id: string ) {

	return [ 'maps', id.toLowerCase() ];

}

async function seedIfEmpty(): Promise<void> {

	const first = kv.list( { prefix: [ 'maps' ] }, { limit: 1 } );
	for await ( const _entry of first ) return; // already has data

	try {

		const staticPath = new URL( '../mapdb.json', import.meta.url );
		const text = await Deno.readTextFile( staticPath );
		const parsed = JSON.parse( text );

		const writes = [];
		for ( const [ id, entry ] of Object.entries( parsed.maps || {} ) ) {

			writes.push( kv.set( key( id ), entry ) );

		}
		await Promise.all( writes );

	} catch ( e ) {

		// No static mapdb.json to seed from -- fine, starts empty.

	}

}

await seedIfEmpty();

export async function listMaps( includeHidden = false ): Promise<Record<string, MapEntry>> {

	const out: Record<string, MapEntry> = {};
	for await ( const entry of kv.list<MapEntry>( { prefix: [ 'maps' ] } ) ) {

		if ( ! includeHidden && entry.value.hidden === true ) continue;
		out[ entry.key[ entry.key.length - 1 ] as string ] = entry.value;

	}
	return out;

}

export async function getMap( id: string ): Promise<MapEntry | null> {

	const entry = await kv.get<MapEntry>( key( id ) );
	return entry.value;

}

export async function setMap( id: string, entry: MapEntry ): Promise<void> {

	await kv.set( key( id ), entry );

}

export async function deleteMap( id: string ): Promise<boolean> {

	const existing = await kv.get( key( id ) );
	if ( existing.value == null ) return false;
	await kv.delete( key( id ) );
	return true;

}
