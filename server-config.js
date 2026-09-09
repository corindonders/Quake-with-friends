// Single place to point the client at your lobby server.
// Edit this once you've deployed server/lobby_server.js somewhere with a
// real domain + TLS certs (see server/README.md). Defaults to localhost for
// local dev/testing.
window.THREE_QUAKE_SERVER = {
	// WebTransport lobby (rooms, hub, travel) -- host:port, no scheme.
	lobby: 'localhost:4433',
	// HTTPS login endpoint (same machine, companion port from lobby_server.js).
	loginUrl: 'https://localhost:4443/login',
};
