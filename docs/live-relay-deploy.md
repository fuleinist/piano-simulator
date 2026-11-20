# Deploy the live relay

The browser cannot open an RTMP socket. It sends WebM chunks over a WebSocket, and the relay in `relay/` transcodes them with ffmpeg. Cloudflare Workers cannot run this relay, because the platform cannot run ffmpeg. You must start it on a host that has ffmpeg.

## The target

You need one address that starts with `wss://`. That address is the value of `VITE_RELAY_URL`.

| Requirement | Why |
|---|---|
| TLS on port 443 | An https page cannot open a `ws://` socket. The app also refuses a plain `ws://` address unless it is localhost. |
| ffmpeg with `libx264` and `aac` | The relay transcodes VP8 with Opus into H.264 with AAC. |
| A long-running process | One ffmpeg child process exists for each live session. |
| `ALLOWED_ORIGINS` set to the site origin | The relay refuses every other page. Use `https://piano-simulator.fuleinist.workers.dev`. |

The account has no domain in Cloudflare. A named tunnel needs a zone, so this document does not cover it.

## Option 1: Your PC and a quick tunnel

This option costs nothing. The PC must stay on while you stream. The address changes each time the tunnel restarts, so you must update the variable and redeploy.

### Faster: one command

Run this in the repository root:

```bash
npm run live
```

The script checks Node, ffmpeg with `libx264` and `aac`, `cloudflared`, the port, and the site origin. Then it starts the relay and the tunnel, and prints the value with the two commands that follow. The steps below show what the script does, for the case where you run each part by hand.

### By hand

1. Install the tunnel client if it is missing: `winget install --id Cloudflare.cloudflared`
2. Start the relay in a terminal and leave it open:

   ```bash
   cd relay
   npm install
   PORT=8088 ALLOWED_ORIGINS=https://piano-simulator.fuleinist.workers.dev npm start
   ```

3. Start the tunnel in a second terminal:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8088
   ```

4. Copy the printed address. It looks like `https://random-words.trycloudflare.com`. Change `https` to `wss`. That is your value.
5. Test the relay before you change the site. Follow the test in "Test the relay" below.
6. Set the variable and redeploy. Follow "Wire the address into the site" below.

Windows Firewall does not need a rule. The tunnel opens an outbound connection, and port 8088 stays on this machine.

A public quick tunnel can be probed by anyone who learns the address. The relay still refuses a foreign page origin, caps sessions, and needs a valid stream key before ffmpeg pushes anything. Keep `MAX_SESSIONS` at `4` or lower.

## Option 2: A hosted machine with a provider hostname

This option keeps the PC free. Fly.io gives each app a hostname with TLS, such as `https://piano-relay.fly.dev`. Your value is that hostname with `wss://` in place of `https://`.

1. Install the CLI: `winget install --id Fly.Flyctl` or use the install script from the Fly.io documentation.
2. Sign in: `fly auth login`
3. Create `relay/Dockerfile`:

   ```dockerfile
   FROM node:22-alpine
   RUN apk add --no-cache ffmpeg
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   ENV PORT=8088
   EXPOSE 8088
   CMD ["node", "server.js"]
   ```

4. Create the app from the `relay` directory: `fly launch --no-deploy`
5. Set the origin and keep one small machine: `fly secrets set ALLOWED_ORIGINS=https://piano-simulator.fuleinist.workers.dev` then `fly scale count 1` and `fly scale memory 512`
6. Deploy: `fly deploy`
7. Your value is the printed hostname with `wss://`, for example `wss://piano-relay.fly.dev`.
8. Test the relay and then wire the address into the site.

Railway and Render work the same way. You enable WebSockets in the project settings, use the Dockerfile above, and take the hostname the provider prints. The relay needs at least 256 MB of memory, and the free tiers of both providers stop an idle service.

## Wire the address into the site

The value enters the bundle at build time. A change to the variable needs a new deploy.

1. Save the variable in the repository:

   ```bash
   gh variable set VITE_RELAY_URL --body "wss://your-relay-host"
   ```

2. Check the value: `gh variable list`
3. Check that the workflow passes it to the build. `.github/workflows/deploy.yml` already contains this step:

   ```yaml
   - name: Build
     run: npm run build
     env:
       VITE_RELAY_URL: ${{ vars.VITE_RELAY_URL }}
   ```

4. Run the deploy: `gh workflow run deploy.yml`, or push to `main`.
5. Check that the deployed bundle carries the address:

   ```bash
   curl -s https://piano-simulator.fuleinist.workers.dev/ | grep -o 'assets/index-[^"]*\.js'
   curl -s https://piano-simulator.fuleinist.workers.dev/assets/index-XXXX.js | grep -o 'wss://[^"]*' | head -1
   ```

6. Open the site. A working build enables the **Go live** button. A disabled button means the build did not receive the value.

## Test the relay

Test the relay before you point the site at it. You need two terminals on any machine that has ffmpeg, and they can be local.

1. Stand in for the platform with a receiver that accepts one connection:

   ```bash
   ffmpeg -y -listen 1 -f flv -i rtmp://127.0.0.1:1935/live/testkey -c copy -f flv out.flv
   ```

2. Start the relay with the site origin allowed:

   ```bash
   cd relay && PORT=8088 ALLOWED_ORIGINS=https://piano-simulator.fuleinist.workers.dev npm start
   ```

3. Open the deployed site, click **Go live**, pick **Custom RTMP**, enter `rtmp://127.0.0.1:1935/live/` as the ingest and `testkey` as the key, then click **Continue** and **Start broadcast**.
4. The hint reads `On air 0:04 · 1.0 MB sent · rtmp://127.0.0.1:1935/live/***`. Stop after ten seconds.
5. Check the received file: `ffprobe -v error -show_entries format=duration -show_entries stream=codec_name out.flv`
6. Expect `h264` and `aac`, and a duration close to the time you streamed. A short file or a decode error points at the relay side.

The relay prints one line for each session, with the key replaced by `***`. A session line with no ffmpeg errors is the pass condition.

## Rotate an address

A quick tunnel gives a new address after each restart.

1. Copy the new address and change `https` to `wss`.
2. Run `gh variable set VITE_RELAY_URL --body "wss://new-address"`
3. Run `gh workflow run deploy.yml`
4. Reload the site. The old page keeps the old address until the new bundle loads.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Go live** stays disabled | The build had no value. | Run `gh variable list`, then redeploy. |
| The tooltip reads "No relay is configured for this build" | The same cause. | The same fix. |
| "The relay needs wss:// (or ws:// on localhost)" | The value uses `ws://` on a public host. | Use `wss://`. |
| "The relay did not answer. Is it running?" | The tunnel is down, or the port is wrong. | Start the relay, then the tunnel, on port 8088. |
| The relay log shows a refused origin | `ALLOWED_ORIGINS` does not list the site origin. | Set the exact origin, including `https://` and no trailing slash. |
| ffmpeg fails at once with code 127 | ffmpeg is not on the host. | Install ffmpeg, or set `FFMPEG_PATH`. |
| The stream stops after a few seconds | The relay hit `MAX_SECONDS`, or the platform refused the key. | Check the relay log and the platform key. |
| Video arrives with no sound | The page never started audio. | Press Play once before **Go live**. |