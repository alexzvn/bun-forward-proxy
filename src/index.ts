import { isAllowed, parseRules } from './access'

type Wire = {
  write: (data: Uint8Array) => number
  end: () => void
  remoteAddress?: string
}

type Peer = {
  socket?: Wire
  pending: Uint8Array[]
  closed: boolean
}

type Session = {
  head: Uint8Array[]
  headLength: number
  phase: 'head' | 'tunnel' | 'closed'
  client: Peer
  upstream: Peer
  target?: string
}

const port = Number(Bun.env.PORT ?? 8080)
const hostname = Bun.env.HOST ?? '::'
const rules = parseRules(Bun.env.ALLOW_IPS)
const maxHead = 32 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const log = (level: 'info' | 'warn', msg: string, extra: Record<string, unknown> = {}) => {
  console[level](JSON.stringify({ level, msg, ...extra }))
}

const createSession = (): Session => ({
  head: [],
  headLength: 0,
  phase: 'head',
  client: { pending: [], closed: false },
  upstream: { pending: [], closed: false },
})

const flush = (peer: Peer) => {
  while (peer.pending.length > 0 && peer.socket) {
    const chunk = peer.pending[0]!
    const written = peer.socket.write(chunk)

    if (written < chunk.byteLength) {
      peer.pending[0] = chunk.subarray(written)
      return
    }

    peer.pending.shift()
  }

  if (peer.closed && peer.pending.length === 0) peer.socket?.end()
}

const send = (peer: Peer, chunk: Uint8Array) => {
  peer.pending.push(chunk)
  flush(peer)
}

const finish = (peer: Peer) => {
  peer.closed = true
  flush(peer)
}

const concat = (chunks: Uint8Array[], length: number) => {
  const merged = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return merged
}

const indexOfHeaderEnd = (buffer: Uint8Array) => {
  for (let i = 3; i < buffer.byteLength; i++) {
    if (buffer[i - 3] === 13 && buffer[i - 2] === 10 && buffer[i - 1] === 13 && buffer[i] === 10) return i + 1
  }

  return -1
}

const splitAuthority = (authority: string, fallbackPort: number) => {
  const bracketed = /^\[(?<host>[^\]]+)\](?::(?<port>\d+))?$/.exec(authority)

  if (bracketed?.groups) {
    return { host: bracketed.groups.host!, port: Number(bracketed.groups.port ?? fallbackPort) }
  }

  const index = authority.lastIndexOf(':')

  if (index === -1) return { host: authority, port: fallbackPort }

  const maybePort = authority.slice(index + 1)

  if (!/^\d+$/.test(maybePort)) return { host: authority, port: fallbackPort }

  return { host: authority.slice(0, index), port: Number(maybePort) }
}

const reply = (session: Session, status: string, body = '') => {
  send(
    session.client,
    encoder.encode(`HTTP/1.1 ${status}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`),
  )
  finish(session.client)
  session.phase = 'closed'
}

const openTunnel = async (session: Session, host: string, targetPort: number, initial?: Uint8Array) => {
  session.target = `${host}:${targetPort}`

  try {
    const upstream = await Bun.connect<Session>({
      hostname: host,
      port: targetPort,
      socket: {
        open: socket => {
          socket.data.upstream.socket = socket
          flush(socket.data.upstream)
        },
        data: (socket, chunk) => send(socket.data.client, chunk),
        drain: socket => flush(socket.data.upstream),
        error: (socket, error) => log('warn', 'upstream error', { target: socket.data.target, error: error.message }),
        close: socket => finish(socket.data.client),
      },
      data: session,
    })

    session.upstream.socket = upstream

    if (initial && initial.byteLength > 0) send(session.upstream, initial)
    else flush(session.upstream)
  } catch (error) {
    log('warn', 'tunnel failed', {
      target: session.target,
      error: error instanceof Error ? error.message : String(error),
    })
    reply(session, '502 Bad Gateway')
  }
}

const handleHead = async (session: Session, raw: Uint8Array, headerEnd: number) => {
  const head = decoder.decode(raw.subarray(0, headerEnd))
  const rest = raw.subarray(headerEnd)
  const [requestLine = '', ...headerLines] = head.split('\r\n')
  const [method = '', target = '', version = 'HTTP/1.1'] = requestLine.split(' ')

  if (method === 'GET' && (target === '/healthz' || target === '/')) {
    reply(session, '200 OK', 'ok')
    return
  }

  const ip = session.client.socket?.remoteAddress

  if (!isAllowed(ip, rules)) {
    log('warn', 'denied', { ip, method, target })
    reply(session, '403 Forbidden')
    return
  }

  session.phase = 'tunnel'

  if (method === 'CONNECT') {
    const { host, port: targetPort } = splitAuthority(target, 443)

    send(session.client, encoder.encode('HTTP/1.1 200 Connection Established\r\n\r\n'))
    await openTunnel(session, host, targetPort, rest)
    return
  }

  let url: URL

  try {
    url = new URL(target)
  } catch {
    reply(session, '400 Bad Request')
    return
  }

  if (url.protocol !== 'http:') {
    reply(session, '400 Bad Request')
    return
  }

  const forwarded = headerLines.filter(line => {
    if (line.length === 0) return false

    const separator = line.indexOf(':')
    const name = separator === -1 ? '' : line.slice(0, separator).toLowerCase()

    return name !== 'proxy-connection' && name !== 'proxy-authorization' && name !== 'connection'
  })

  const rewritten = encoder.encode(
    [`${method} ${url.pathname}${url.search} ${version}`, ...forwarded, 'connection: close', '', ''].join('\r\n'),
  )
  const initial = new Uint8Array(rewritten.byteLength + rest.byteLength)

  initial.set(rewritten)
  initial.set(rest, rewritten.byteLength)

  await openTunnel(session, url.hostname, url.port.length > 0 ? Number(url.port) : 80, initial)
}

const server = Bun.listen<Session>({
  hostname,
  port,
  socket: {
    open: socket => {
      socket.data = createSession()
      socket.data.client.socket = socket
    },
    data: async (socket, chunk) => {
      const session = socket.data

      if (session.phase === 'tunnel') {
        send(session.upstream, chunk)
        return
      }

      if (session.phase === 'closed') return

      session.head.push(chunk)
      session.headLength += chunk.byteLength

      if (session.headLength > maxHead) {
        reply(session, '431 Request Header Fields Too Large')
        return
      }

      const raw = concat(session.head, session.headLength)
      const headerEnd = indexOfHeaderEnd(raw)

      if (headerEnd === -1) return

      session.head = []
      session.headLength = 0

      await handleHead(session, raw, headerEnd)
    },
    drain: socket => flush(socket.data.client),
    error: (socket, error) => {
      log('warn', 'client error', { target: socket.data.target, error: error.message })
      socket.data.upstream.socket?.end()
    },
    close: socket => {
      socket.data.phase = 'closed'
      finish(socket.data.upstream)
    },
  },
  data: createSession(),
})

log('info', 'proxy listening', {
  hostname,
  port: server.port,
  allowlist: rules.length === 0 ? 'open' : rules.length,
})

const shutdown = () => {
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
