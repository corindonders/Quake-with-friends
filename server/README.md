# Three-Quake Dedicated Server

A dedicated server for Three-Quake that runs headlessly using Deno and
WebSocket.

## Requirements

- [Deno](https://deno.land/) v1.40 or later
- A copy of `pak0.pak` (and `pak1.pak` for the registered content some mods
  need — see below) from Quake
- TLS is *optional* at this layer -- see "Transport: WebSocket, not
  WebTransport" below for why, and how to deploy without managing certs at
  all.

## Lobby + rooms + hub + login (current architecture)

`lobby_server.js` is the one public-facing process: it handles login,
the room lobby (list/create/join), and relays gameplay traffic to whichever
room a player joined. Rooms are separate `game_server.js` processes (each a
real headless copy of the engine — the same `src/` code the browser runs,
not a reimplementation), spawned and managed by `room_process_manager.ts`.
They listen on `127.0.0.1` only; the lobby is their sole client. `rooms.ts`
is an older, unused single-process room registry — ignore it.

`auth.ts` + `manage_users.ts` add admin-managed login accounts (Deno KV,
PBKDF2-hashed passwords, no self-signup). `lobby_server.js` requires a
valid session token on every lobby request (list/create/join) — that's the
gate a client has to pass before it even learns a room exists. It also
always keeps one persistent room alive: the hub (`HUBWLD`, Copper's own
`start` map), for players to land in after logging in before picking a
world, via the in-game "Travel" button (`src/travel_ui.js`).

`mapdb.ts` is the map catalog itself -- also Deno KV, seeded once from the
repo's root `mapdb.json` the first time it's empty, then KV is the source
of truth (the static file is only a seed/local-testing fallback after
that). Admins edit it live from `admin.html`; `GET /api/mapdb` (any logged-
in session, not just admins) is what `maps.html` and the in-game Travel
menu actually read.

`player_progress.ts` persists each player's health/armor/ammo/weapons to
Deno KV keyed by username (their account, not a specific room), restoring
it on their next spawn anywhere. See its own header comment and
`src/progress_hooks.js` for how it hooks into the shared engine code
without the engine importing Deno-specific code directly.

`admin.html` is the day-to-day admin surface (accounts, the map catalog,
active rooms) -- `manage_users.ts` is only needed to bootstrap the first
admin account before any of that is reachable.

### Transport: WebSocket, not WebTransport

Earlier revisions of this server used WebTransport (HTTP/3 + QUIC). It's
since been replaced with plain WebSocket, because **WebTransport cannot be
proxied through a Cloudflare Tunnel** (or most reverse proxies) — Cloudflare
terminates HTTP/3 at its edge and speaks HTTP/1.1 or HTTP/2 to the origin,
so the end-to-end QUIC session WebTransport requires can never reach a
tunneled server. WebSockets proxy through Cloudflare Tunnel with zero
special config, which is the deployment this project actually targets (a
homelab/Proxmox box, no port-forwarding, no cert management — Cloudflare's
edge cert covers it). The old WebTransport code
(`src/net_webtransport.js`, `server/net_webtransport_server.ts`) is left in
place but unused, only still referenced by the legacy prototype below.

One consequence: **room processes need no TLS certs of their own** (see
Requirements above) — they're loopback-only, and the lobby is the only
thing that ever connects to them, relaying whichever public connection
they came from. Only the lobby itself needs a cert, and only if you're not
putting a TLS-terminating proxy (Cloudflare Tunnel, nginx, Caddy, etc.) in
front of it — pass `-cert`/`-key` for that direct-exposure case, or omit
them entirely to serve plain HTTP/WS (fine behind a proxy, and the easiest
way to test locally with no certs at all).

### 1. Create accounts

```bash
cd server
deno run --allow-read --allow-write --unstable-kv manage_users.ts add yourname yourpassword --admin
deno run --allow-read --allow-write --unstable-kv manage_users.ts add friendname somepassword
deno run --allow-read --allow-write --unstable-kv manage_users.ts list
```

Accounts live in `server/data/users.db` (Deno KV, gitignored — never commit it).

### 2. Run the lobby

Local dev (no certs, talks plain HTTP/WS — point a plain `http://` client at it):

```bash
export THREE_QUAKE_SECRET=$(openssl rand -hex 32)   # reserved for future per-room ticket verification
deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -pak ../pak0.pak -allow-origin "*" -verbose
```

Deployed behind Cloudflare Tunnel (same — the tunnel handles TLS, so the
lobby still serves plain HTTP/WS on localhost; point `cloudflared`'s
ingress at `http://localhost:4433`):

```bash
deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -pak ../pak0.pak -allow-origin https://yourname.github.io
```

Direct exposure with your own cert (no proxy in front):

```bash
deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -cert cert.pem -key key.pem -pak ../pak0.pak -allow-origin https://yourname.github.io
```

- `-port` — the one public port: login (`POST /login`), lobby, and relay all share it
- `-cert`/`-key` — optional; omit when a reverse proxy/tunnel terminates TLS for you
- `-allow-origin` — CORS origin allowed to call `/login` (your deployed client's origin)
- `-verbose` (or `THREE_QUAKE_VERBOSE=1`) — full logs instead of the quiet allowlist in `sys_server.ts`
- pak1.pak/pak2.pak next to `pak0.pak` are picked up automatically if present (registered content)

### 3. Point the client at it

Edit `server-config.js` at the repo root:

```js
window.THREE_QUAKE_SERVER = {
	lobby: 'yourdomain.com:4433', // or localhost:4433 for local dev
};
```

The client derives ws(s):// and http(s):// from whichever protocol the
page itself was loaded with (a local `http://` dev page talks plain
`ws://`/`http://`; a deployed `https://` page talks `wss://`/`https://`),
so no separate scheme config is needed.

Loading `index.html` with no `?map=`/`?room=` now requires login
(redirects to `login.html`) and then auto-joins the hub. The in-hub
"Travel" button lists worlds from the live map catalog (`mapdb.ts`,
editable from `admin.html`) and creates/joins a room for whichever one is
picked — mod dirs are passed straight through to the room process the
same way `?mod=` works for the browser client (`COM_LoadMod`, now
Deno-side too, in `server/game_server.js`).

**Security note:** when `THREE_QUAKE_SECRET` is set, room processes verify a
short-lived ticket (`auth.ts`'s `createRoomTicket`/`verifyRoomTicket`, HMAC-
signed) that the lobby mints for the joining player and passes as `?ticket=`
on the loopback relay connection — closing the gap where anything else on
the same machine could otherwise open a raw WebSocket straight to a room's
port and be treated as a legitimate player. Without the secret set, room
processes fall back to trusting any connection (a startup warning says so),
same as before this existed — set the `THREE_QUAKE_SECRET` env var (see the
`export THREE_QUAKE_SECRET=...` line above) for any deployment where the
server machine isn't fully trusted.

## Legacy prototype (`main.ts` / `host_server.ts`)

The rest of this document (below) describes an earlier, incomplete
single-process prototype (`main.ts`, `host_server.ts`,
`net_webtransport_server_test.ts`) that never got full QuakeC/physics
integration, and used WebTransport besides — superseded by the lobby/room
architecture above. Left as-is; not the thing to run.

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
