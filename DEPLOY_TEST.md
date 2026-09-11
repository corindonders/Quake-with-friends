# Phase 1: Localhost test on Proxmox (before Cloudflare)

This is a dry run of [DEPLOY.md](DEPLOY.md): same container, same
git-pull-based update pipeline, same systemd service — but reachable only
on your LAN, with no Cloudflare Tunnel yet. Get this working first, then
add the tunnel as the last step to go public.

## Why do this first

- Confirms Deno, the pak files, and the lobby/room process model all work
  on the actual Proxmox container before adding Cloudflare into the
  picture.
- Confirms the `git pull` + restart deploy pipeline works end-to-end.
- If something's broken, you're debugging one variable (the server) instead
  of two (the server + the tunnel).

## 1. Container + dependencies

Same as [DEPLOY.md](DEPLOY.md) steps 1-2: create the LXC container, install
Deno.

```bash
apt update && apt install -y git unzip curl
curl -fsSL https://deno.land/install.sh | sh
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
deno --version
```

## 2. Clone the repo and add game data

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/<your-username>/Quake-with-friends.git
cd Quake-with-friends
```

Copy `pak0.pak` (and `pak1.pak` if used) into `/opt/Quake-with-friends/`.

## 3. Bootstrap a test account

```bash
cd /opt/Quake-with-friends/server
deno run --allow-read --allow-write --unstable-kv manage_users.ts add tester testpass --admin
```

## 4. Run the lobby server directly (no systemd yet) — plain HTTP, LAN only

```bash
cd /opt/Quake-with-friends/server
export THREE_QUAKE_SECRET=$(openssl rand -hex 32)
deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -pak ../pak0.pak -allow-origin "*"
```

Leave `-allow-origin "*"` for this local test only — tighten it once you
know the real client origin (step 7 of DEPLOY.md).

Note the container's LAN IP (`ip addr` or check the Proxmox UI).

## 5. Serve the static client, also LAN only

In a second shell on the same container:

```bash
cd /opt/Quake-with-friends
deno run --allow-net --allow-read jsr:@std/http/file-server --port 8080
```

Edit `server-config.js` at the repo root to point at the container's LAN IP:

```js
window.THREE_QUAKE_SERVER = {
	lobby: '192.168.x.x:4433',   // your container's LAN IP
};
```

(This file isn't committed with real values — edit it locally on the
container after each `git pull`, or keep a local override; see the note at
the bottom.)

## 6. Test from your PC's browser

Visit `http://192.168.x.x:8080` from a machine on the same LAN. Confirm:

- [ ] Login page loads, `tester`/`testpass` logs in
- [ ] Auto-joins the hub room after login
- [ ] Travel menu lists maps and can create/join a room
- [ ] `journalctl`/terminal output on the container shows no errors during
      connect, travel, and gameplay

This proves the actual game loop (lobby → room process → WebSocket relay)
works on Proxmox, independent of Cloudflare.

## 7. Turn it into the real git-pull pipeline (still localhost only)

Now wire up the same deploy mechanism DEPLOY.md uses for production, but
targeting the LAN-only config, so you're testing the *pipeline* too, not
just the server.

`/etc/systemd/system/qwf-lobby.service`:

```ini
[Unit]
Description=Quake with Friends lobby server (test)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/Quake-with-friends/server
Environment=THREE_QUAKE_SECRET=<paste the value you generated in step 4>
ExecStart=/root/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
  --unstable-kv --config deno.json lobby_server.js \
  -port 4433 -pak ../pak0.pak -allow-origin "*"
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/qwf-static.service`:

```ini
[Unit]
Description=Quake with Friends static client (test)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/Quake-with-friends
ExecStart=/root/.deno/bin/deno run --allow-net --allow-read jsr:@std/http/file-server --port 8080
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now qwf-lobby qwf-static
systemctl status qwf-lobby qwf-static
```

Kill the two manual shells from step 4/5 (Ctrl+C) now that systemd owns
them.

`/opt/Quake-with-friends/deploy.sh`:

```bash
#!/bin/bash
set -e
cd /opt/Quake-with-friends
git pull
systemctl restart qwf-lobby qwf-static
echo "Deployed $(git rev-parse --short HEAD)"
```

```bash
chmod +x deploy.sh
```

### Exercise the pipeline

1. On your dev PC, make a trivial change (e.g. a comment or a version
   string), commit, push to GitHub.
2. On the container:
   ```bash
   /opt/Quake-with-friends/deploy.sh
   ```
3. Confirm the change is live at `http://192.168.x.x:8080` and
   `git rev-parse --short HEAD` in the output matches your latest commit.
4. Or trigger it remotely from your PC:
   ```bash
   ssh root@192.168.x.x '/opt/Quake-with-friends/deploy.sh'
   ```

If this round-trip works, the same `deploy.sh` is what DEPLOY.md step 8
uses in production — nothing changes about the pipeline itself when you add
the tunnel, only the ingress in front of it.

## 8. Promote to production (add Cloudflare)

Once steps 1-7 are solid:

1. Follow [DEPLOY.md](DEPLOY.md) step 7 to install `cloudflared` and route
   your domain to `http://localhost:4433` (and `:8080` if serving the
   client from the same box).
2. Tighten `-allow-origin` in the systemd unit from `"*"` to your real
   deployed origin, then `systemctl restart qwf-lobby`.
3. Re-run the checklist in step 6, this time from outside your LAN via your
   Cloudflare domain instead of the container's IP.

## Notes

- `server-config.js` differs between test (LAN IP) and production (your
  domain) — since it's a tracked file, either keep the production value
  committed and temporarily edit it on the container for local testing
  (don't commit that edit), or maintain it as a local override the deploy
  script doesn't touch. Pick whichever fits how you plan to iterate.
- Everything in this phase runs with `-allow-origin "*"` and no
  `THREE_QUAKE_SECRET` persistence plan beyond the systemd unit file —
  fine for a LAN-only test, not for the public deployment in DEPLOY.md.
