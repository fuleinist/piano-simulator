# Streaming relay

The browser cannot open an RTMP socket. This relay takes WebM chunks over a
WebSocket, transcodes them with ffmpeg, and pushes FLV to the platform ingest.

## Requirements

- Node 20 or newer.
- ffmpeg on `PATH`, built with `libx264` and `aac`.
- A platform that accepts an RTMP or RTMPS ingest.

## Run

```bash
cd relay
npm install
PORT=8088 ALLOWED_ORIGINS=https://piano-simulator.fuleinist.workers.dev npm start
```

Then build the site with the relay address:

```bash
VITE_RELAY_URL=wss://relay.example.com npm run build
```

Without `VITE_RELAY_URL`, the Go live button stays disabled and the rest of the
app works as before.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8088` | Listen port. Put a TLS terminator in front for `wss://`. |
| `ALLOWED_ORIGINS` | localhost 5173 and 4174 | Comma-separated page origins. Any other origin is refused. |
| `MAX_SESSIONS` | `4` | Concurrent ffmpeg processes. |
| `MAX_SECONDS` | `14400` | Hard limit for one session. |
| `FFMPEG_PATH` | `ffmpeg` | Path to the binary. |

## What the relay does not do

- It does not store the stream or the key. The key lives in memory for the
  session and is cleared when the socket closes.
- It does not accept a target outside `rtmp://` or `rtmps://`.
- It does not fan out to several destinations. One session, one ingest.
