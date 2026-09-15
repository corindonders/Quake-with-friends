// Dev-only static file server that disables all caching, unlike `python -m
// http.server` (no Cache-Control header -> browsers apply heuristic caching
// and can serve stale JS modules indefinitely across reloads, even hard
// reloads, without a single network round-trip). Serves the repo root.
import { serveDir } from 'jsr:@std/http/file-server';

const root = decodeURIComponent( new URL( '../', import.meta.url ).pathname ).replace( /^\/([A-Za-z]:)/, '$1' );

Deno.serve( { port: 8123 }, ( req ) => {

	return serveDir( req, { fsRoot: root, headers: [ 'Cache-Control: no-store' ] } );

} );
