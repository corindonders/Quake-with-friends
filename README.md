# Quake with Friends

A port of Quake to Three.js — this fork turns it into a small
login-gated multiplayer server for a private friend group: accounts,
a shared hub world, mod support (Copper, Fantasy Quake), a
browsable/admin-editable map catalog, and per-account progress that
follows you between rooms.

### Play

Once a server is running (see `server/README.md`), open `index.html`
(or wherever it's deployed) and log in. New players: read
[`wiki.html`](wiki.html) first — controls, console commands, and a
per-mod enemy/item reference. Admins: see `admin.html` for account and
map management.

### Original project

This is a fork of mrdoob's [three-quake](https://github.com/mrdoob/three-quake)
([dev log](https://x.com/mrdoob/status/2015076521531355583)), which is
playable as-is (no login, single-player/public multiplayer) at
https://mrdoob.github.io/three-quake/.

### Assets

Shareware `pak0.pak` included (Episode 1).
For the full game, replace with your own `pak0.pak` (and optionally
`pak1.pak`) from a registered copy of Quake -- see `server/README.md`
for where these need to live for a server deployment.

### License

Code: GPL v2

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Three.js port by [@mrdoob](https://github.com/mrdoob) with [@claude](https://github.com/claude)
- Login/hub/multiplayer/admin fork additions with [Claude](https://claude.com/claude-code)
