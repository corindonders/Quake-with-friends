// Player progress persistence hooks -- lets a Deno room process wire up
// save/load without the shared engine code (host_cmd.js, sv_main.js) ever
// importing Deno-specific KV code directly. Unused in the browser (single
// player never calls Host_SetProgressHooks, so these are no-ops there).
//
// Identity: the authenticated username is carried for free through Quake's
// own "name" mechanism -- the client sets its in-game name to its username
// right after login (see main.js), so host_client.name / ent.v.netname is
// already the right key server-side, no protocol changes needed.

let _onSpawn = null; // ( username: string, ent: edict_t ) => void
let _onDisconnect = null; // ( username: string, ent: edict_t ) => void

export function Host_SetProgressHooks( hooks ) {

	if ( hooks.onSpawn ) _onSpawn = hooks.onSpawn;
	if ( hooks.onDisconnect ) _onDisconnect = hooks.onDisconnect;

}

/**
 * Called right after a client's QuakeC spawn functions (ClientConnect,
 * PutClientInServer) run. The hook applies saved stats asynchronously --
 * PutClientInServer already ran and set default spawn stats, so there's a
 * brief (sub-second) window before saved stats land. Acceptable for a
 * casual co-op game; not worth threading async through the whole synchronous
 * command-execution path to close.
 */
export function PlayerProgress_OnSpawn( username, ent ) {

	if ( _onSpawn ) _onSpawn( username, ent );

}

/**
 * Called as a client is dropped, before QuakeC's ClientDisconnect runs and
 * before the client_t is cleared, so both the entity fields and the
 * username are still valid to read.
 */
export function PlayerProgress_OnDisconnect( username, ent ) {

	if ( _onDisconnect ) _onDisconnect( username, ent );

}
