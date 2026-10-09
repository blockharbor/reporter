# Deploying reporter

This guide covers deploying the **server** on an Ubuntu machine and installing the **desktop app** (macOS) and **terminal recorder** (macOS/Linux) that connect to it.

- Part A — [Server on Ubuntu](#part-a--server-on-ubuntu)
- Part B — [Desktop app on macOS](#part-b--desktop-app-on-macos)
- Part C — [Terminal recorder](#part-c--terminal-recorder)
- [Getting API keys](#getting-api-keys) · [Updating](#updating) · [Backups](#backups) · [Troubleshooting](#troubleshooting)

The only thing your teammates' machines need to reach is the server's URL (e.g. `http://192.168.1.50`). Everything else is local to each machine.

---

## Part A — Server on Ubuntu

### 1. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # then log out/in so `docker` works without sudo
```

Verify: `docker compose version`.

### 2. Get the code

```bash
git clone <your-repo-url> reporter
cd reporter
```

(Or copy the project directory to the server via `scp`/`rsync`.)

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

| Variable                         | Set to                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                 | a long random string — generate with `openssl rand -hex 32`                                           |
| `DB_PASSWORD`                    | a strong database password                                                                            |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | the first admin login (or leave blank to use the web `/setup` screen)                                 |
| `APP_URL`                        | `http://<server-ip>` (the URL clients/browsers use — no port, with the default `HTTP_PORT=80`)        |
| `HTTP_PORT`                      | leave at `80` for a port-less URL; set to e.g. `8080` only if port 80 is already in use on the server |

Quick generation:

```bash
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 16)|" .env
```

### 4. Launch

```bash
docker compose up -d --build
```

The first run builds the image (a few minutes), starts PostgreSQL, applies database migrations automatically, and — if `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set — creates the first admin.

Check it:

```bash
docker compose ps
curl -s http://localhost/web/flags             # {"appName":"reporter","needsSetup":false,...}
docker compose logs -f app                      # watch boot / migrations
```

Open `http://<server-ip>` in a browser and sign in. (If you left the admin vars blank, the first visit shows a one-time **Create admin** screen.)

### 5. Open the firewall (if `ufw` is enabled)

```bash
sudo ufw allow 80/tcp
```

(Use the matching port if you changed `HTTP_PORT`.)

### 6. (Optional) HTTPS with a reverse proxy

The default is plain HTTP for a trusted LAN. For HTTPS, front it with [Caddy](https://caddyserver.com) (automatic certificates). Add to `docker-compose.yml`:

```yaml
caddy:
  image: caddy:2
  ports: ['80:80', '443:443']
  command: caddy reverse-proxy --from reporter.example.com --to app:8080
  depends_on: [app]
  restart: unless-stopped
```

Then set `APP_URL=https://reporter.example.com` in `.env` (this makes session cookies `Secure`) and `docker compose up -d`.

---

## Part B — Desktop app (macOS, Windows, Linux)

Same tray app on all three OSes. Prebuilt artifacts land in `apps/desktop/release/`:

| OS      | Artifact                                                             | Notes                                                                                                                                                        |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS   | `reporter-<version>-universal.dmg`                                   | Universal — runs on Apple Silicon **and** Intel. Ad-hoc signed.                                                                                              |
| Windows | `reporter-<version>-win-x64-portable.zip`                            | Portable — unzip and run `reporter.exe`. (For a real `.exe` installer, see [CI builds](#getting-real-installers-ci) — Wine on Apple Silicon can't build it.) |
| Linux   | `reporter-<version>-x86_64.AppImage`, `reporter-<version>-amd64.deb` | AppImage: `chmod +x` and run. deb: `sudo apt install ./…deb`.                                                                                                |

### Building the artifacts yourself

Prerequisites: [Node.js 20+](https://nodejs.org), pnpm (`npm install -g pnpm`), and (for Linux/Windows on a non-Linux host) Docker.

```bash
cd reporter
pnpm install
pnpm --filter @reporter/desktop build

# macOS universal (.dmg) — build on a Mac:
cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --universal --publish never

# Linux (AppImage + deb) — build on Linux, or via Docker from any host:
docker run --rm -v "$PWD":/project electronuserland/builder:wine \
  bash -c "cd /project/apps/desktop && npx --yes electron-builder@25 --linux --publish never"

# Windows portable zip — the Docker build assembles apps/desktop/release/win-unpacked;
# zip that folder. A real NSIS installer must be built on Windows/CI (see below).
```

<a id="getting-real-installers-ci"></a>
**Getting real installers (CI).** Wine can't run on Apple Silicon (16K memory pages), so a proper Windows `.exe` installer can't be produced on a Mac. The repo includes `.github/workflows/release.yml`, which builds signed-ready installers for **all three OSes on their native GitHub runners** (macOS `.dmg`, Windows `.exe`, Linux `.AppImage`/`.deb`) plus the terminal-recorder tarball. Push a `v*` tag (or run it manually) and download the artifacts.

### Install — macOS

1. Open the `.dmg` and drag **reporter** to Applications.
2. **Clear the quarantine flag** so Gatekeeper allows the un-notarized app:
   ```bash
   xattr -dr com.apple.quarantine /Applications/reporter.app
   ```
   (macOS flags anything copied from another Mac / downloaded. On macOS 15+ the right-click→Open shortcut no longer bypasses this, so the command above is the reliable method.)
3. Launch it — the app runs in the **menu bar** (tray), not the Dock.

> The `.dmg` is **ad-hoc signed** (via the `afterPack` hook) but **not notarized**. **"reporter.app is damaged"** means a broken/unsigned build — rebuild with the current hook, or re-sign a copy in place: `codesign --deep --force --sign - /Applications/reporter.app` then the `xattr` command above. A prompt-free install needs an Apple Developer ID (notarization) in `electron-builder.yml`.

### Install — Windows

1. Unzip `reporter-<version>-win-x64-portable.zip`.
2. Run `reporter.exe` inside the extracted folder. (SmartScreen may warn about an unknown publisher on an unsigned build — **More info → Run anyway**.)
3. The app lives in the **system tray**. For a Start-menu installer instead of the portable app, use the CI-built `.exe`.

### Install — Linux

- **AppImage:** `chmod +x reporter-<version>-x86_64.AppImage && ./reporter-<version>-x86_64.AppImage`
- **deb:** `sudo apt install ./reporter-<version>-amd64.deb`

The app runs in the system tray. On **Wayland**, global hotkeys don't fire — use the tray menu or bind a shortcut to `reporter-desktop --capture-area`.

### Configure (all platforms)

1. Click the menu-bar icon → **Settings**.
2. Enter the **Server URL** (`http://<server-ip>`) and your **Access key** + **Secret key** — see [Getting API keys](#getting-api-keys).
3. Click **Test connection**; on success it loads your engagements. Pick a **Current engagement**.

### Grant capture permission (macOS)

On macOS the first screenshot capture triggers a **Screen Recording** permission prompt (System Settings → Privacy & Security → Screen Recording). Enable **reporter** and relaunch it. On Windows/Linux, configure the capture command in Settings if the default doesn't fit your setup.

### Use

- Tray/menu-bar menu → **Capture area** / **Capture window**, or the global hotkeys **⌘/Ctrl+Shift+7** / **⌘/Ctrl+Shift+8**.
- Add a description + tags in the compose window → **Add evidence**. Items queue and upload automatically; **History** shows status and lets you retry failures.

---

## Part C — Terminal recorder

`reporter-term` records shell sessions as asciicast and uploads them as evidence. Works on **macOS, Linux, and Windows** — the _same_ tarball installs on all three (node-pty pulls the right binary per platform).

### Build the tarball (once)

Prerequisites: Node.js 20+ and pnpm.

```bash
cd reporter
pnpm install
pnpm --filter @reporter/term run pack          # NOTE: `run pack`, not `pnpm pack`
```

This produces a self-contained tarball at `apps/term/reporter-term-<version>.tgz` (only `node-pty` is a runtime dependency; everything else is bundled). Copy it to each machine and install:

### Install per OS

```bash
npm install -g ./reporter-term-0.1.0.tgz
```

- **macOS / Windows** — installs directly (node-pty ships prebuilt binaries).
- **Linux** — node-pty has no Linux prebuild, so it compiles on install. Install a toolchain first:
  ```bash
  sudo apt-get install -y python3 make g++     # Debian/Ubuntu
  npm install -g ./reporter-term-0.1.0.tgz
  ```

### Configure & use

```bash
reporter-term setup     # server URL + API keys (interactive); or just run `reporter-term` the first time
reporter-term           # records your shell — work as normal, then type `exit` or Ctrl-D
```

After the session ends, choose **Upload** (pick engagement, description, tags), **Keep locally**, or **Discard**. Other commands: `reporter-term upload <file.cast>`, `reporter-term config`.

---

## Getting API keys

Both clients authenticate with an **access key + secret key** pair:

1. Sign in to the web UI (`http://<server-ip>`).
2. Go to **Account → API keys → New key**.
3. Copy the **access key** and **secret key** (the secret is shown once). Paste them into the desktop app's Settings or `reporter-term setup`.

---

## Updating

**Server:**

```bash
cd reporter
git fetch origin
git reset --hard origin/main   # make the checkout match the remote exactly
docker compose up -d --build   # rebuilds; migrations re-apply automatically
```

> **Why `fetch` + `reset` and not `git pull`.** `git pull` has to reconcile your local
> `main` with the remote one, so it stops with
> `fatal: Need to specify how to reconcile divergent branches` whenever the published
> history has been rewritten, and it silently writes a merge commit the rest of the time.
> Resetting takes the remote as the truth and skips both problems.
>
> **It does not touch your data.** The database and the evidence blobs live in the named
> Docker volumes `reporter_pgdata` and `reporter_blobdata`, outside the checkout, and
> `.env` is untracked — a reset leaves all three exactly as they are. What it _does_
> discard is local edits to tracked files, so run `git status` first and copy aside
> anything of your own. Take a [backup](#backups) before any update regardless.

**Clients:** rebuild the `.dmg` / tarball and reinstall (steps above).

## Backups

State lives in two places — the database and the blob volume:

```bash
# Database
docker compose exec db pg_dump -U reporter reporter > reporter-db.sql
# Evidence blobs
docker run --rm -v reporter_blobdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/reporter-blobs.tgz -C /data .
```

Restore into a fresh stack: load the SQL with `psql`, and untar the blobs back into the volume. See [apps/server/README.md](apps/server/README.md#backup--restore).

## Troubleshooting

| Symptom                                                        | Fix                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `docker compose` build fails on `node-pty`                     | The provided Dockerfile installs the build toolchain; ensure you're using the repo's `Dockerfile` unchanged.       |
| App container restarts, logs `PrismaClientInitializationError` | The runtime needs `openssl` (already in the Dockerfile). Rebuild with `docker compose up -d --build`.              |
| `needsSetup: true` unexpectedly                                | The users table is empty — set `ADMIN_*` in `.env` and recreate the app container, or use the web `/setup` screen. |
| Desktop app "can't be opened" (unidentified developer)         | Right-click the app → **Open** (unsigned build).                                                                   |
| Desktop screenshots do nothing on macOS                        | Grant **Screen Recording** permission and relaunch.                                                                |
| Global hotkeys don't fire (Linux/Wayland)                      | Use the tray menu, or bind a shortcut to `reporter-desktop --capture-area`.                                        |
| `reporter-term` install pulls wrong deps                       | Use `pnpm --filter @reporter/term run pack` (with `run`), then install the tarball it prints.                      |
