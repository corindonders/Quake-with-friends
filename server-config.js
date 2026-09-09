// Single place to point the client at your lobby server.
// Edit this once you've deployed server/lobby_server.js somewhere (e.g.
// behind a Cloudflare Tunnel -- see server/README.md). Defaults to plain
// local HTTP for local dev/testing (no certs needed for that).
window.THREE_QUAKE_SERVER = {
	// Lobby (login, rooms, hub, travel) -- host:port, no scheme. The client
	// derives ws(s):// and http(s):// from this based on the page's own
	// protocol (https page -> wss/https; http page, e.g. local dev -> ws/http).
	lobby: 'localhost:4433',
};
