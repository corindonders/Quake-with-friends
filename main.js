// Three-Quake entry point
// Equivalent to WinQuake/sys_win.c WinMain() + main()

import { Sys_Init, Sys_Printf, Sys_Error } from './src/sys.js';
import { COM_InitArgv } from './src/common.js';
import { Host_Init, Host_Frame, Host_Shutdown } from './src/host.js';
import { COM_FetchPak, COM_AddPack, COM_LoadMod } from './src/pak.js';
import { Cbuf_AddText } from './src/cmd.js';
import { requireSession, fetchMapdb } from './src/auth_client.js';
import { WS_SetAuthToken } from './src/net_websocket.js';
import { TravelUI_Init } from './src/travel_ui.js';
import { cls, cl } from './src/client.js';
import { sv } from './src/server.js';
import { scene, camera } from './src/gl_rmain.js';
import { renderer } from './src/vid.js';
import { Draw_CachePicFromPNG } from './src/gl_draw.js';
import { XR_Init } from './src/webxr.js';

const parms = {
	basedir: '.',
	argc: 0,
	argv: []
};

async function main() {

	try {

		// Redirects to login.html if not signed in.
		const session = requireSession();
		if ( session === null ) return;

		WS_SetAuthToken( session.token );

		Sys_Init();

		COM_InitArgv( parms.argv );

		// Loading bar
		const loadingProgress = document.getElementById( 'loading-progress' );
		const loadingOverlay = document.getElementById( 'loading' );

		function setProgress( value ) {

			if ( loadingProgress ) {

				loadingProgress.style.width = ( value * 100 ) + '%';

			}

		}

		// Load pak0.pak from the same directory
		Sys_Printf( 'Loading pak0.pak...\\n' );
		const pak0 = await COM_FetchPak( 'pak0.pak', 'pak0.pak', setProgress );
		if ( pak0 ) {

			COM_AddPack( pak0 );
			Sys_Printf( 'pak0.pak loaded successfully\\n' );

		} else {

			Sys_Printf( 'Warning: pak0.pak not found - game data will be missing\\n' );

		}

		// Load pak1.pak, pak2.pak, ... if present (registered/full game content).
		// Sequential per Quake convention: stop at the first one that's missing.
		for ( let i = 1; i < 10; i ++ ) {

			const packName = 'pak' + i + '.pak';
			const pak = await COM_FetchPak( packName, packName, null );
			if ( ! pak ) break;

			COM_AddPack( pak );
			Sys_Printf( packName + ' loaded successfully\\n' );

		}

		await Host_Init( parms );

		// Use the authenticated username as the in-game name. This is also
		// how the server identifies whose progress to save/restore (see
		// src/progress_hooks.js) -- no separate identity channel needed,
		// Quake already sends "name" to the server on connect.
		if ( session.username ) {

			Cbuf_AddText( 'name "' + session.username + '"\n' );

		}

		// Check URL parameters
		const urlParams = new URLSearchParams( window.location.search );
		const mapName = urlParams.get( 'map' );
		const explicitRoomId = urlParams.get( 'room' );

		// No explicit map or room requested: we're about to auto-join the hub
		// below, which is Copper's own "start" map -- the client needs that
		// mod's assets loaded too, same as the room does server-side.
		const joiningHub = ! mapName && ! explicitRoomId &&
			!! ( window.THREE_QUAKE_SERVER && window.THREE_QUAKE_SERVER.lobby );

		// Layer mod/map directories onto the search path, e.g. ?mod=mods/copper&map=frogsbog
		// Directories are layered in order given, each taking priority over
		// the last (and over the base game) for paks, progs.dat, and
		// on-demand loose files (maps, sounds, etc).
		let modDirs = ( urlParams.get( 'mod' ) || '' )
			.split( ',' )
			.map( ( s ) => s.trim() )
			.filter( ( s ) => s.length > 0 );

		if ( modDirs.length === 0 && joiningHub ) {

			modDirs = [ 'mods/copper' ];

		}

		// If no mod was given explicitly but the requested map is listed in
		// the (admin-editable) map catalog, use the layers it declares (e.g.
		// a map built for a mod automatically pulls that mod in with it).
		if ( modDirs.length === 0 && mapName ) {

			const maps = await fetchMapdb();
			const entry = maps[ mapName ];
			if ( entry && entry.layers ) modDirs = entry.layers;

		}

		for ( const modDir of modDirs ) {

			Sys_Printf( 'Loading mod: ' + modDir + '...\\n' );
			await COM_LoadMod( modDir );

		}

		// Remove loading overlay
		if ( loadingOverlay ) {

			loadingOverlay.remove();

		}

		TravelUI_Init();

		// Preload custom menu images
		try {

			await Draw_CachePicFromPNG( 'gfx/mainmenu_ext.lmp', 'mainmenu.png' );
			Sys_Printf( 'Loaded custom menu images\\n' );

		} catch ( e ) {

			Sys_Printf( 'Warning: Could not load custom menu images\\n' );

		}

		// Auto-load a map, e.g. ?map=frogsbog (fetched on demand via COM_EnsureFile,
		// checking mod dirs above before the base game's maps/ folder)
		if ( mapName ) {

			Cbuf_AddText( 'map ' + mapName + '\n' );

		}

		// Check URL parameters for auto-join
		let roomId = explicitRoomId;
		let serverUrl = urlParams.get( 'server' );

		// No explicit map or room requested: land in the persistent hub room
		// on the configured lobby server, same as everyone else who just
		// logged in -- that's the "meet up before picking a world" flow.
		if ( joiningHub ) {

			roomId = 'HUBWLD';

		}

		// Fill in the configured lobby whenever the URL didn't specify one --
		// this covers both the hub above and an explicit ?room= share link
		// (e.g. from menu.js's "share this room" flow), which only ever
		// encodes the room ID, not a server. Match the page's own protocol --
		// ws(s) is derived from this.
		if ( roomId && ! serverUrl && window.THREE_QUAKE_SERVER && window.THREE_QUAKE_SERVER.lobby ) {

			serverUrl = ( window.location.protocol === 'https:' ? 'https://' : 'http://' ) + window.THREE_QUAKE_SERVER.lobby;

		}

		if ( roomId ) {

			serverUrl = serverUrl || 'https://wts.mrdoob.com:4433';
			const connectUrl = serverUrl + '?room=' + encodeURIComponent( roomId );
			Sys_Printf( 'Auto-joining room: %s\\n', roomId );
			Cbuf_AddText( 'connect "' + connectUrl + '"\n' );

		}

		// Initialize WebXR (creates rig, offers VR session — must be after Host_Init)
		XR_Init( scene );

		// Expose for debugging
		window.Cbuf_AddText = Cbuf_AddText;
		window.cls = cls;
		window.cl = cl;
		window.sv = sv;
		window.scene = scene;
		Object.defineProperty( window, 'camera', { get: () => camera } );
		Object.defineProperty( window, 'renderer', { get: () => renderer } );

		let oldtime = performance.now() / 1000;

		// Use renderer.setAnimationLoop instead of requestAnimationFrame.
		// This is required for WebXR — Three.js automatically switches to
		// xrSession.requestAnimationFrame when a VR session is active.
		// In non-XR mode, behavior is identical to regular rAF.
		renderer.setAnimationLoop( function ( timestamp ) {

			const newtime = timestamp / 1000;
			const time = newtime - oldtime;
			oldtime = newtime;

			Host_Frame( time );

		} );

	} catch ( e ) {

		console.error( 'Three-Quake Fatal Error:', e );
		Sys_Error( e.message );

	}

}

main();
