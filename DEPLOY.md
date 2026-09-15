# Deploying Quake with Friends to Proxmox

This is a plan for running the game's lobby/room server on your Proxmox box and
exposing it through your Cloudflare URL, with updates pulled from this GitHub
repo (`git pull` based, not CI/CD).

Reference: [server/README.md](server/README.md) already documents the
server architecture and flags — this plan wraps that in Proxmox-specific
steps (container, systemd service, Cloudflare Tunnel, update workflow).

## 0. Architecture recap

- `server/lobby_server.js` is the one public-facing process (Deno). It
  handles login, the room lobby, and relays gameplay traffic to per-room
  `game_server.js` child processes (loopback-only).
- Transport is plain WebSocket (not WebTransport) specifically so it can sit
  behind Cloudflare Tunnel with zero cert management.
- The client (static HTML/JS) is served separately — either from the same
  Proxmox box or from any static host (e.g. GitHub Pages) — and points at
  the lobby via `server-config.js`.

You need on Proxmox: **Deno**, this **git repo**, your **pak0.pak** (+
optional pak1.pak), and **cloudflared**.

## 1. Create an LXC container (recommended over a VM)

In the Proxmox web UI:

1. **Create CT** → Debian 12 (or Ubuntu 22.04) template.
2. Resources: 1-2 vCPU, 1-2 GB RAM, 8 GB disk is plenty for a lobby +
   a handful of room processes.
3. Enable unprivileged container (default) unless you have a specific
   reason not to.
4. Network: bridged to your LAN (`vmbr0`), DHCP or static IP — doesn't need
   to be internet-facing, since Cloudflare Tunnel makes outbound-only
   connections.
5. Start the container, then `pct enter <vmid>` from the Proxmox shell (or
   SSH in) to continue.

## 2. Install dependencies in the container

```bash
apt update && apt install -y git unzip curl
curl -fsSL https://deno.land/install.sh | sh
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
deno --version
```

## 3. Clone the repo and add game data

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/<your-username>/Quake-with-friends.git
cd Quake-with-friends
```

Copy `pak0.pak` (and `pak1.pak` if you use registered content) into the repo
root — `scp` them from your PC, or copy from a mounted share. They're
git-ignored/tracked already per your repo state; either way they need to
exist at `/opt/Quake-with-friends/pak0.pak`.

## 4. Bootstrap accounts

```bash
cd /opt/Quake-with-friends/server
deno run --allow-read --allow-write --unstable-kv manage_users.ts add yourname yourpassword --admin
deno run --allow-read --allow-write --unstable-kv manage_users.ts add friendname somepassword
```

Accounts live in `server/data/users.db` (Deno KV) — back this up
separately; it's gitignored and won't come from `git pull`.

## 5. Run the lobby server as a systemd service

Create `/etc/systemd/system/qwf-lobby.service`:

```ini
[Unit]
Description=Quake with Friends lobby server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/Quake-with-friends/server
Environment=THREE_QUAKE_SECRET=<generate with: openssl rand -hex 32>
ExecStart=/root/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -pak ../pak0.pak -allow-origin "https://your-cloudflare-domain.com"
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Adjust `-allow-origin` to whatever origin your client is actually served
from (your Cloudflare domain if you serve the static client through the
same tunnel, or a GitHub Pages URL, etc.).

```bash
systemctl daemon-reload
systemctl enable --now qwf-lobby
systemctl status qwf-lobby
journalctl -u qwf-lobby -f   # tail logs
```

## 6. Serve the static client

Two options — pick one:

**A. Same box, one Cloudflare Tunnel, two routes (simplest).**
Serve the repo root as static files (the client HTML/JS/assets) on a second
local port, e.g. with Deno's built-in file server or any static server:

```bash
cd /opt/Quake-with-friends
deno run --allow-net --allow-read jsr:@std/http/file-server --port 8080
```

Run this as a second systemd service (`qwf-static.service`) the same way as
above.

**B. GitHub Pages / other static host for the client, Proxmox only runs the
lobby.** Simpler split, no need to serve static files yourself — just point
`server-config.js` in the deployed client at your Cloudflare domain.

Either way, edit `server-config.js` at the repo root before deploying the
client:

```js
window.THREE_QUAKE_SERVER = {
	lobby: 'your-cloudflare-domain.com', // no port needed if tunnel maps it to 443
};
```

## 7. Cloudflare Tunnel

On the Proxmox container:

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' | tee /etc/apt/sources.list.d/cloudflared.list
apt update && apt install -y cloudflared

cloudflared tunnel login
cloudflared tunnel create qwf
```

Configure `/etc/cloudflared/config.yml`:

```yaml
tunnel: qwf
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: your-cloudflare-domain.com
    service: http://localhost:4433
  # If serving the static client from the same box on 8080, add a second
  # hostname/route (or path-based routing) here, e.g.:
  # - hostname: play.your-cloudflare-domain.com
  #   service: http://localhost:8080
  - service: http_status:404
```

```bash
cloudflared tunnel route dns qwf your-cloudflare-domain.com
systemctl enable --now cloudflared
```

Since the lobby serves plain HTTP/WS and Cloudflare terminates TLS at the
edge, this is exactly the deployment `server/README.md` describes — no
certs to manage on the box at all.

## 8. Updating from GitHub

Since you want to update the Proxmox files from your GitHub repo, use a
simple pull-and-restart flow rather than a CI pipeline:

```bash
cd /opt/Quake-with-friends
git pull
systemctl restart qwf-lobby
# systemctl restart qwf-static   # if you're using option A above
```

Save this as `/opt/Quake-with-friends/deploy.sh`:

```bash
#!/bin/bash
set -e
cd /opt/Quake-with-friends
git pull
systemctl restart qwf-lobby
echo "Deployed $(git rev-parse --short HEAD)"
```

```bash
chmod +x deploy.sh
```

Then from your dev machine, deploying is just:

```bash
ssh root@proxmox-ct-ip '/opt/Quake-with-friends/deploy.sh'
```

**Optional — auto-pull on a timer.** If you'd rather not SSH in manually,
add a systemd timer that runs `deploy.sh` every few minutes and only
restarts when `git pull` actually changes something:

```bash
#!/bin/bash
cd /opt/Quake-with-friends
BEFORE=$(git rev-parse HEAD)
git pull -q
AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" != "$AFTER" ]; then
  systemctl restart qwf-lobby
  echo "$(date): deployed $AFTER"
fi
```

Wire it to a `qwf-deploy.timer`/`.service` pair (`OnUnitActiveSec=5min`) if
you want this hands-off. Skip this if you'd rather trigger updates
manually — active rooms get killed on lobby restart, so an unattended
restart mid-session is a tradeoff worth deciding on purpose.

## 9. Sanity checklist after first deploy

- [ ] `systemctl status qwf-lobby` is active
- [ ] `curl -I https://your-cloudflare-domain.com` returns a response
- [ ] Log in from the deployed client with an account from step 4
- [ ] Confirm hub room auto-joins after login (persistent `HUBWLD` room)
- [ ] Create/join a second room via Travel to confirm room process spawning
      works (`room_process_manager.ts`)
- [ ] `journalctl -u qwf-lobby -f` while testing to watch for errors

## Notes / gotchas specific to this repo

- `server/data/` (Deno KV: users, map catalog overrides, player progress) is
  local state, not tracked by git — `git pull` never touches it. Back it up
  separately if you care about losing accounts/progress.
- `mapdb.json` at repo root is only a **seed** for the map catalog on first
  boot; after that, KV is authoritative and edits happen live via
  `admin.html`, so `git pull` updates to `mapdb.json` won't retroactively
  change a running deployment's catalog.
- If you ever change `-allow-origin`, restart `qwf-lobby` for it to take
  effect (CORS is enforced by the running process, not read live).
- Room processes bind to `127.0.0.1` only — never expose port range(s)
  beyond the lobby's single public port through the tunnel.
