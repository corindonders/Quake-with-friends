// PAK file loader -- new module for browser-based asset loading
// Quake stores all game data in pak0.pak (and optionally pak1.pak)
// PAK format: 4-byte magic "PACK", 4-byte directory offset, 4-byte directory length
// Directory entries: 56-byte filename + 4-byte offset + 4-byte length

import { Sys_Printf, Sys_Error } from './sys.js';
import { Con_Printf } from './common.js';

const MAX_FILES_IN_PACK = 2048;

class packfile_t {

	constructor() {

		this.name = '';
		this.filepos = 0;
		this.filelen = 0;

	}

}

class pack_t {

	constructor() {

		this.filename = '';
		this.files = []; // array of packfile_t
		this.data = null; // ArrayBuffer of the entire pak

	}

}

// Search paths
let com_searchpaths = []; // array of { pack, path }

// Loaded packs
const loadedPacks = [];

// Virtual files (for loose files not in pak)
const virtualFiles = new Map();

// Base paths for on-demand loose file fetching, tried in order (first match wins).
// Browser: [''] (relative URLs like 'maps/foo.bsp')
// Deno: ['/opt/three-quake/'] (absolute filesystem path)
// Mod directories are unshifted to the front so they take priority over the base game.
let looseFileSearchDirs = [ '' ];

/*
=================
COM_LoadPackFile

Takes an ArrayBuffer of the .pak file contents
Returns a pack_t or null
=================
*/
export function COM_LoadPackFile( filename, buffer ) {

	const view = new DataView( buffer );

	// Check header
	const id0 = view.getUint8( 0 );
	const id1 = view.getUint8( 1 );
	const id2 = view.getUint8( 2 );
	const id3 = view.getUint8( 3 );

	if ( id0 !== 0x50 || id1 !== 0x41 || id2 !== 0x43 || id3 !== 0x4B ) { // 'PACK'

		Sys_Error( filename + ' is not a packfile' );
		return null;

	}

	const dirofs = view.getInt32( 4, true );
	const dirlen = view.getInt32( 8, true );

	const numpackfiles = Math.floor( dirlen / 64 ); // each dir entry is 64 bytes

	if ( numpackfiles > MAX_FILES_IN_PACK )
		Sys_Error( filename + ' has too many files (' + numpackfiles + ')' );

	const pack = new pack_t();
	pack.filename = filename;
	pack.data = buffer;

	const bytes = new Uint8Array( buffer );

	for ( let i = 0; i < numpackfiles; i ++ ) {

		const entryOffset = dirofs + i * 64;
		const file = new packfile_t();

		// Read filename (56 bytes, null terminated)
		let name = '';
		for ( let j = 0; j < 56; j ++ ) {

			const c = bytes[ entryOffset + j ];
			if ( c === 0 ) break;
			name += String.fromCharCode( c );

		}

		file.name = name.toLowerCase();
		file.filepos = view.getInt32( entryOffset + 56, true );
		file.filelen = view.getInt32( entryOffset + 60, true );

		pack.files.push( file );

	}

	Con_Printf( 'Added packfile ' + filename + ' (' + numpackfiles + ' files)\\n' );

	loadedPacks.push( pack );

	return pack;

}

/*
=================
COM_AddGameDirectory

Sets up the search path for a game directory
=================
*/
export function COM_AddGameDirectory( dir ) {

	com_searchpaths.push( { pack: null, path: dir } );

}

/*
=================
COM_AddPack

Adds a loaded pack to the search path
=================
*/
export function COM_AddPack( pack ) {

	com_searchpaths.unshift( { pack: pack, path: null } );

}

/*
=================
COM_FindFile

Searches through the path looking for a file.
Returns { data: Uint8Array, size: number } or null
=================
*/
export function COM_FindFile( filename ) {

	const search = filename.toLowerCase();

	// Search through loaded packs (reverse order - last added has priority)
	for ( let i = 0; i < com_searchpaths.length; i ++ ) {

		const sp = com_searchpaths[ i ];
		if ( ! sp.pack ) continue;

		const pack = sp.pack;
		for ( let j = 0; j < pack.files.length; j ++ ) {

			if ( pack.files[ j ].name === search ) {

				const file = pack.files[ j ];
				const data = new Uint8Array( pack.data, file.filepos, file.filelen );
				return { data: data, size: file.filelen };

			}

		}

	}

	// Check virtual files (preloaded loose files)
	if ( virtualFiles.has( search ) ) {

		const data = virtualFiles.get( search );
		return { data: data, size: data.length };

	}

	return null;

}

/*
=================
COM_SetLooseFileBasePath

Sets the base path for on-demand loose file fetching.
Browser: '' (default, uses relative URLs)
Deno: '/opt/three-quake/' (absolute filesystem path)
=================
*/
export function COM_SetLooseFileBasePath( basePath ) {

	looseFileSearchDirs = [ basePath ];

}

/*
=================
COM_AddModSearchDir

Adds a directory to the front of the loose-file search list, so files
under it (custom maps, sounds, etc.) are found before the base game's.
Normalizes to always end with a single trailing slash (unless empty).
=================
*/
export function COM_AddModSearchDir( dir ) {

	if ( dir && ! dir.endsWith( '/' ) ) dir += '/';
	looseFileSearchDirs.unshift( dir );

}

/*
=================
COM_EnsureFile

Checks if a file is available in pak or virtualFiles.
If not, tries fetching it on demand from each loose-file search dir
(mod dirs first, then the base path), caching the first one that works.
Returns a Promise<boolean>.
=================
*/
export async function COM_EnsureFile( filename ) {

	// Already available in pak or virtualFiles?
	if ( COM_FindFile( filename ) !== null ) {

		return true;

	}

	for ( const dir of looseFileSearchDirs ) {

		if ( await COM_PreloadLooseFile( filename, dir + filename ) ) {

			return true;

		}

	}

	return false;

}

/*
=================
COM_PreloadLooseFile

Fetches a loose file from URL/path and adds it to virtualFiles.
Used for custom maps not included in pak files.
In Deno, reads from filesystem. In browser, uses fetch().
=================
*/
export async function COM_PreloadLooseFile( filename, url ) {

	try {

		let data;

		// Check if running in Deno
		if ( typeof Deno !== 'undefined' ) {

			// Load from filesystem in Deno
			try {

				data = await Deno.readFile( url );

			} catch ( e ) {

				return false;

			}

		} else {

			// Browser: use fetch
			const response = await fetch( url );
			if ( ! response.ok ) {

				return false;

			}

			const buffer = await response.arrayBuffer();
			data = new Uint8Array( buffer );

		}

		virtualFiles.set( filename.toLowerCase(), data );
		return true;

	} catch ( e ) {

		return false;

	}

}

/*
=================
COM_PreloadMaps

Preloads loose map files from the maps/ directory.
basePath is optional - used by Deno server to specify absolute path.
=================
*/
export async function COM_PreloadMaps( mapList, basePath ) {

	let loaded = 0;

	// Default base path, or use provided one (for Deno server)
	const base = basePath || 'maps/';

	for ( const mapName of mapList ) {

		const filename = 'maps/' + mapName + '.bsp';
		const url = base + mapName + '.bsp';

		if ( await COM_PreloadLooseFile( filename, url ) ) {

			loaded ++;

		}

	}

	if ( loaded > 0 ) {

		Sys_Printf( 'Preloaded %d custom maps\\n', loaded );

	}

	return loaded;

}

/*
=================
COM_LoadFile

Loads a file from the pack system.
Returns an ArrayBuffer of the file contents, or null if not found.
=================
*/
export function COM_LoadFile( filename ) {

	const result = COM_FindFile( filename );
	if ( ! result ) return null;

	// Return a copy of the data as an ArrayBuffer
	const buf = new ArrayBuffer( result.size );
	const dest = new Uint8Array( buf );
	dest.set( result.data );
	return buf;

}

/*
=================
COM_LoadFileAsString

Convenience: load a file and return it as a string
=================
*/
export function COM_LoadFileAsString( filename ) {

	const result = COM_FindFile( filename );
	if ( ! result ) return null;

	let str = '';
	for ( let i = 0; i < result.size; i ++ ) {

		str += String.fromCharCode( result.data[ i ] );

	}

	return str;

}

/*
=================
COM_FetchPak

Fetches a .pak file from a URL using fetch(), returns a Promise<pack_t>
In Deno, loads from filesystem. In browser, uses fetch().
=================
*/
export async function COM_FetchPak( url, filename, onProgress ) {

	Sys_Printf( 'Fetching ' + url + '...\\n' );

	// Check if running in Deno
	if ( typeof Deno !== 'undefined' ) {

		// Load from filesystem in Deno
		try {

			const data = await Deno.readFile( url );
			if ( onProgress ) onProgress( 1 );
			return COM_LoadPackFile( filename, data.buffer );

		} catch ( e ) {

			Con_Printf( 'Failed to load ' + url + ': ' + e.message + '\\n' );
			return null;

		}

	}

	// Browser: use fetch
	const response = await fetch( url );
	if ( ! response.ok ) {

		Con_Printf( 'Failed to fetch ' + url + ': ' + response.statusText + '\\n' );
		return null;

	}

	let buffer;
	const contentLength = response.headers.get( 'content-length' );

	if ( onProgress && contentLength && response.body ) {

		const total = parseInt( contentLength, 10 );
		const reader = response.body.getReader();
		const chunks = [];
		let received = 0;

		while ( true ) {

			const { done, value } = await reader.read();
			if ( done ) break;

			chunks.push( value );
			received += value.length;
			onProgress( Math.min( 1, received / total ) );

		}

		buffer = new ArrayBuffer( received );
		const dest = new Uint8Array( buffer );
		let offset = 0;
		for ( const chunk of chunks ) {

			dest.set( chunk, offset );
			offset += chunk.length;

		}

	} else {

		buffer = await response.arrayBuffer();
		if ( onProgress ) onProgress( 1 );

	}

	Sys_Printf( 'Loaded ' + url + ' (' + buffer.byteLength + ' bytes)\\n' );

	return COM_LoadPackFile( filename || url, buffer );

}

/*
=================
COM_TryFetchBytes

Silently attempts to fetch a URL/path, returning a Uint8Array or null.
Used for existence probing (e.g. mod loading) where a 404/missing file
is an expected outcome, not something worth logging.
=================
*/
async function COM_TryFetchBytes( url ) {

	try {

		if ( typeof Deno !== 'undefined' ) {

			return await Deno.readFile( url );

		}

		const response = await fetch( url );
		if ( ! response.ok ) return null;

		return new Uint8Array( await response.arrayBuffer() );

	} catch ( e ) {

		return null;

	}

}

/*
=================
COM_WrapFileAsPack

Wraps a single loose file's bytes in a minimal in-memory .pak so it can
be added via COM_AddPack. Packs are searched before virtualFiles, so
this is how a loose override file (e.g. a mod's progs.dat) can take
priority over a same-named file already bundled inside another pak.
=================
*/
export function COM_WrapFileAsPack( filename, data ) {

	const headerSize = 12;
	const dirEntrySize = 64;
	const dataOffset = headerSize;
	const dirOffset = dataOffset + data.length;

	const buffer = new ArrayBuffer( dirOffset + dirEntrySize );
	const view = new DataView( buffer );
	const bytes = new Uint8Array( buffer );

	bytes[ 0 ] = 0x50; bytes[ 1 ] = 0x41; bytes[ 2 ] = 0x43; bytes[ 3 ] = 0x4B; // 'PACK'
	view.setInt32( 4, dirOffset, true );
	view.setInt32( 8, dirEntrySize, true );
	bytes.set( data, dataOffset );

	const nameBytes = new TextEncoder().encode( filename.toLowerCase() );
	for ( let i = 0; i < 56; i ++ ) bytes[ dirOffset + i ] = i < nameBytes.length ? nameBytes[ i ] : 0;
	view.setInt32( dirOffset + 56, dataOffset, true );
	view.setInt32( dirOffset + 60, data.length, true );

	return COM_LoadPackFile( filename + '.override', buffer );

}

/*
=================
COM_LoadMod

Layers a mod/map directory onto the search path, mirroring Quake's
"-game <dir>" convention:
  - <dir>/pak0.pak, pak1.pak, ... (sequential, stops at first missing)
    are added as packs.
  - <dir>/progs.dat, if present, overrides any progs.dat already found
    in a pack (packs are searched before loose files, so a plain loose
    override wouldn't otherwise win against e.g. the base game's pak0).
  - <dir>/ itself is added as a loose-file search dir, so custom maps,
    sounds, etc. not shipped in a pak are still found on demand by
    COM_EnsureFile.

Can be called multiple times to layer several directories (each call's
files take priority over the previous one's).
Returns a Promise<{ dir, paksAdded, progsOverridden }>.
=================
*/
export async function COM_LoadMod( dir ) {

	dir = dir.replace( /\/+$/, '' );
	const result = { dir: dir, paksAdded: 0, progsOverridden: false };

	for ( let i = 0; i < 10; i ++ ) {

		const url = dir + '/pak' + i + '.pak';
		const bytes = await COM_TryFetchBytes( url );
		if ( ! bytes ) break;

		const pack = COM_LoadPackFile( url, bytes.buffer );
		if ( ! pack ) break;

		COM_AddPack( pack );
		result.paksAdded ++;
		Sys_Printf( 'Mod: added ' + url + ' (' + pack.files.length + ' files)\\n' );

	}

	const progsBytes = await COM_TryFetchBytes( dir + '/progs.dat' );
	if ( progsBytes ) {

		const pack = COM_WrapFileAsPack( 'progs.dat', progsBytes );
		if ( pack ) {

			COM_AddPack( pack );
			result.progsOverridden = true;
			Sys_Printf( 'Mod: overriding progs.dat from ' + dir + '/progs.dat\\n' );

		}

	}

	COM_AddModSearchDir( dir + '/' );

	return result;

}
