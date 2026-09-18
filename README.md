# bun-forward-proxy

HTTP forward proxy with `CONNECT` tunneling, built on `Bun.listen` / `Bun.connect`. No `node:*` imports, no dependencies. Made for pointing headless Chromium (`--proxy-server=`) at a remote egress IP, e.g. a Fly.io machine.

## Why not `Bun.serve`

`Bun.serve` cannot host a `CONNECT` proxy (verified on Bun 1.4.0):

| attempt | result |
| --- | --- |
| `server.upgrade(req)` inside `fetch` | returns `false` — WebSocket handshake headers required, no raw-socket handoff |
| `new Response(stream)` + read `req.body` | `req.body` is `undefined` for `CONNECT`, so client bytes are unreachable |
| answering `CONNECT` with 200 | handshake completes, then the socket is closed ([oven-sh/bun#37585](https://github.com/oven-sh/bun/pull/37585)) |

`Bun.listen` is the Bun-native primitive that exposes raw duplex sockets, so the proxy is built there.

## Run

```sh
bun install
bun start          # PORT=8080 by default
bun run test
```

```sh
export PUPPETEER_PROXY="http://127.0.0.1:8080"   # headless Chromium via puppeteer
chromium --proxy-server=http://127.0.0.1:8080    # or directly
```

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | listen port |
| `HOST` | `::` | listen address |
| `ALLOW_IPS` | _(unset)_ | comma/space separated IPv4/IPv6 CIDRs allowed to use the proxy; unset means **open to anyone that can reach the port** |

`GET /healthz` answers `ok` and bypasses the allowlist, so platform health checks keep working.

Browsers ignore credentials embedded in `--proxy-server=http://user:pass@host` — Chromium answers a `407` with an interactive dialog no automation can fill. That is why this proxy has no `Proxy-Authorization` support: authorize by source IP (`ALLOW_IPS`) or by keeping the listener on a private network.

## Behaviour notes

- `CONNECT host:port` is spliced byte for byte, with backpressure handled through partial-write requeue plus `drain`.
- Absolute-form requests (`GET http://host/path`) are rewritten to origin-form; `proxy-connection`, `proxy-authorization` and `connection` are dropped and `connection: close` is forced, because browsers pool plain-HTTP proxy connections per proxy rather than per origin — reusing a spliced socket would misroute request #2 to the previous host.
- Per-connection state is allocated in `open`; the listener-level `data` object in `Bun.listen` is shared by every accepted socket.
- Request heads over 32 KiB are rejected with `431`.

## License

MIT
