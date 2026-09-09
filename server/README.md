# Three-Quake Dedicated Server

A dedicated server for Three-Quake that runs headlessly using Deno and WebTransport.

## Requirements

- [Deno](https://deno.land/) v1.40 or later
- A copy of `pak0.pak` (and `pak1.pak` for the registered content some mods
  need — see below) from Quake
- TLS certificates (required for WebTransport and the login endpoint)

## Lobby + rooms + hub + login (current architecture)

This is what actually runs in production: `lobby_server.js` listens on one
port and spawns a separate `game_server.js` process per room (each one a
real headless copy of the engine — the same `src/` code the browser runs,
not a reimplementation). `room_process_manager.ts` manages those child
processes; `rooms.ts` is an older, unused single-process room registry —
ignore it.

On top of that: `auth.ts` + `manage_users.ts` add admin-managed login
accounts (Deno KV, PBKDF2-hashed passwords, no self-signup), and
`lobby_server.js` requires a valid session token on every lobby request
(list/create/join) — that's the gate a client has to pass before it even
learns a room's port. It also always keeps one persistent room alive: the
hub (`HUBWLD`, Copper's own `start` map), for players to land in after
logging in before picking a world.

**Security note:** the token gate is enforced at the lobby only. The room
processes themselves (`game_server.js` / `net_webtransport_server.ts`)
don't yet re-verify who's connecting — reasonable for a small trusted group
where room ports/IDs are never listed anywhere except an authenticated
lobby response, but worth knowing if you ever open this beyond people you
trust. `auth.ts` already has `createRoomTicket`/`verifyRoomTicket` (HMAC via
`THREE_QUAKE_SECRET`) ready for wiring into the room handshake if you want
to close that gap later.

### 1. Create accounts

```bash
cd server
deno run --allow-read --allow-write --unstable-kv manage_users.ts add yourname yourpassword --admin
deno run --allow-read --allow-write --unstable-kv manage_users.ts add friendname somepassword
deno run --allow-read --allow-write --unstable-kv manage_users.ts list
```

Accounts live in `server/data/users.db` (Deno KV, gitignored — never commit it).

### 2. Generate TLS certs (dev) and set the shared secret

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
export THREE_QUAKE_SECRET=$(openssl rand -hex 32)   # needed even though room tickets aren't checked yet
```

### 3. Run the lobby

```bash
deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-net --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -httpport 4443 -cert cert.pem -key key.pem -pak ../pak0.pak \
  -allow-origin https://yourname.github.io
```

- `-port` — WebTransport lobby port (rooms spawn on 4434+)
- `-httpport` — HTTPS login endpoint (`POST /login`, same certs)
- `-allow-origin` — CORS origin allowed to call `/login` (your deployed client's origin)
- `-verbose` (or `THREE_QUAKE_VERBOSE=1`) — full logs instead of the quiet allowlist in `sys_server.ts`
- pak1.pak/pak2.pak next to `pak0.pak` are picked up automatically if present (registered content)

### 4. Point the client at it

Edit `server-config.js` at the repo root:

```js
window.THREE_QUAKE_SERVER = {
	lobby: 'yourdomain.com:4433',
	loginUrl: 'https://yourdomain.com:4443/login',
};
```

Loading `index.html` with no `?map=`/`?room=` now requires login
(redirects to `login.html`) and then auto-joins the hub. The in-hub
"Travel" button (`src/travel_ui.js`) lists worlds from the root
`mapdb.json` and creates/joins a room for whichever one is picked — mod
dirs are passed straight through to the room process the same way
`?mod=` works for the browser client (`COM_LoadMod`, now Deno-side too).

## Legacy prototype (`main.ts` / `host_server.ts`)

The rest of this document (below) describes an earlier, incomplete
single-process prototype (`main.ts`, `host_server.ts`,
`net_webtransport_server_test.ts`) that never got full QuakeC/physics
integration — superseded by the lobby/room architecture above. Left as-is;
not the thing to run.

## Quick Start

### 1. Generate TLS Certificates (Development)

For local development, generate self-signed certificates:

```bash
cd server
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

### 2. Place Game Data

Make sure `pak0.pak` is in the parent directory (`../pak0.pak` from the server folder).

### 3. Run the Server

```bash
deno run --allow-net --allow-read --allow-env main.ts
```

Or use the task:

```bash
deno task start
```

## Command Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `-port <port>` | 4433 | Server port |
| `-maxclients <num>` | 16 | Maximum players |
| `-map <name>` | start | Starting map |
| `-pak <path>` | ../pak0.pak | Path to pak0.pak |
| `-cert <path>` | cert.pem | TLS certificate file |
| `-key <path>` | key.pem | TLS private key file |
| `-tickrate <hz>` | 72 | Server tick rate |

### Example

```bash
deno run --allow-net --allow-read main.ts -port 4433 -map e1m1 -maxclients 8
```

## Connecting from Browser

In the Three-Quake browser client, use the `connect` command:

```
connect wts://your-server.com:4433
```

Or for localhost development:

```
connect wts://localhost:4433
```

Note: WebTransport requires HTTPS/TLS. For development, you may need to configure your browser to trust the self-signed certificate.

## Production Deployment

### Using Let's Encrypt

For production, use proper TLS certificates from Let's Encrypt:

```bash
certbot certonly --standalone -d your-domain.com
```

Then point the server to the certificates:

```bash
deno run --allow-net --allow-read main.ts \
  -cert /etc/letsencrypt/live/your-domain.com/fullchain.pem \
  -key /etc/letsencrypt/live/your-domain.com/privkey.pem
```

### Docker

```dockerfile
FROM denoland/deno:1.40

WORKDIR /app
COPY server/ ./server/
COPY pak0.pak ./

EXPOSE 4433

CMD ["deno", "run", "--allow-net", "--allow-read", "server/main.ts"]
```

Build and run:

```bash
docker build -t three-quake-server .
docker run -p 4433:4433 -v /path/to/certs:/app/server three-quake-server
```

## Architecture

The server uses:

- **WebTransport** over HTTP/3 (QUIC) for network transport
- **Bidirectional streams** for reliable messages (spawn data, level changes)
- **Datagrams** for unreliable messages (entity updates at 72Hz)

### Files

- `main.ts` - Entry point and server loop
- `host_server.ts` - Headless server initialization and frame processing
- `net_webtransport_server.ts` - WebTransport server driver
- `pak_server.ts` - Filesystem-based PAK file loading
- `sys_server.ts` - Deno system interface
- `mod_server.ts` - Headless BSP model loader (collision data only)

## Status

This is currently a work-in-progress. The following is implemented:

- [x] WebTransport server listening
- [x] Client connection handling
- [x] PAK file loading from filesystem
- [x] BSP collision data loading
- [ ] Full QuakeC VM integration
- [ ] Entity synchronization
- [ ] Physics simulation
- [ ] Complete game protocol

## License

GPL v2 (same as original Quake source)
