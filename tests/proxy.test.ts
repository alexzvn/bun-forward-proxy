import { afterAll, describe, expect, test } from 'bun:test'
import type { Socket, Subprocess } from 'bun'
import { isAllowed, parseRules } from '../src/access'

type Tunnel = {
  request: (payload: string, expected: string) => Promise<string>
  close: () => void
}

const decoder = new TextDecoder()
const cleanups: Array<() => void> = []

const freePort = async () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
  const { port } = probe

  probe.stop(true)

  return port
}

const startProxy = async (env: Record<string, string> = {}) => {
  const port = await freePort()
  const proc = Bun.spawn(['bun', `${import.meta.dir}/../src/index.ts`], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  cleanups.push(() => proc.kill())

  const reader = proc.stdout.getReader()
  let seen = ''

  while (!seen.includes('proxy listening')) {
    const { value, done } = await reader.read()

    if (done) break
    if (value) seen += decoder.decode(value)
  }

  reader.releaseLock()
  expect(seen).toContain('proxy listening')

  return { port, proc: proc as Subprocess }
}

const startOrigin = async (body: string) => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const received = await request.text()
      const suffix = received.length > 0 ? ` body=${received}` : ''

      return new Response(`${body} ${new URL(request.url).pathname}${suffix}`)
    },
  })

  cleanups.push(() => server.stop(true))

  return server
}

const openTunnel = async (proxyPort: number, authority: string): Promise<Tunnel> => {
  let buffer = ''
  let closed = false
  let notify: (() => void) | undefined

  const socket: Socket<undefined> = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxyPort,
    socket: {
      data: (_socket, chunk) => {
        buffer += decoder.decode(chunk)
        notify?.()
      },
      error: () => {},
      close: () => {
        closed = true
        notify?.()
      },
    },
  })

  const waitFor = async (predicate: () => boolean) => {
    while (!predicate()) {
      if (closed) throw new Error('tunnel closed before the expected bytes arrived')

      await new Promise<void>(resolve => {
        notify = resolve
      })
    }

    notify = undefined
  }

  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
  await waitFor(() => buffer.includes('\r\n\r\n'))

  const status = buffer.split('\r\n')[0] ?? ''

  buffer = ''

  if (!status.includes('200')) {
    socket.end()
    throw new Error(`tunnel rejected: ${status}`)
  }

  return {
    request: async (payload, expected) => {
      buffer = ''
      socket.write(payload)
      await waitFor(() => buffer.includes(expected))

      return buffer
    },
    close: () => socket.end(),
  }
}

afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

describe('access', () => {
  test('empty allowlist permits every client', () => {
    const rules = parseRules(undefined)

    expect(rules).toHaveLength(0)
    expect(isAllowed('203.0.113.7', rules)).toBe(true)
    expect(isAllowed(undefined, rules)).toBe(true)
  })

  test('matches ipv4 prefixes and rejects outsiders', () => {
    const rules = parseRules('203.0.113.0/24, 10.0.0.5')

    expect(isAllowed('203.0.113.200', rules)).toBe(true)
    expect(isAllowed('10.0.0.5', rules)).toBe(true)
    expect(isAllowed('203.0.114.1', rules)).toBe(false)
    expect(isAllowed('10.0.0.6', rules)).toBe(false)
    expect(isAllowed(undefined, rules)).toBe(false)
  })

  test('treats ipv4-mapped ipv6 clients as ipv4', () => {
    const rules = parseRules('127.0.0.1/32')

    expect(isAllowed('::ffff:127.0.0.1', rules)).toBe(true)
    expect(isAllowed('::1', rules)).toBe(false)
  })

  test('matches compressed ipv6 prefixes', () => {
    const rules = parseRules('fdaa:1::/32')

    expect(isAllowed('fdaa:1:0:a:b:c:d:e', rules)).toBe(true)
    expect(isAllowed('fdaa:2::1', rules)).toBe(false)
  })

  test('rejects malformed entries loudly', () => {
    expect(() => parseRules('203.0.113.0/33')).toThrow(/invalid ALLOW_IPS/)
    expect(() => parseRules('not-an-ip')).toThrow(/invalid ALLOW_IPS/)
  })
})

describe('proxy', () => {
  test('answers health checks without an allowlist match', async () => {
    const { port } = await startProxy({ ALLOW_IPS: '198.51.100.1/32' })
    const response = await fetch(`http://127.0.0.1:${port}/healthz`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  test('forwards absolute-form http requests', async () => {
    const [{ port }, origin] = await Promise.all([startProxy(), startOrigin('origin-a')])
    const response = await fetch(`http://127.0.0.1:${origin.port}/plain`, {
      proxy: `http://127.0.0.1:${port}`,
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('origin-a /plain')
  })

  test('forwards request bodies after the rewritten head', async () => {
    const [{ port }, origin] = await Promise.all([startProxy(), startOrigin('origin-post')])
    const response = await fetch(`http://127.0.0.1:${origin.port}/upload`, {
      method: 'POST',
      body: 'payload-4a9f',
      headers: { 'content-type': 'text/plain' },
      proxy: `http://127.0.0.1:${port}`,
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('origin-post /upload body=payload-4a9f')
  })

  test('tunnels CONNECT traffic byte for byte', async () => {
    const [{ port }, origin] = await Promise.all([startProxy(), startOrigin('origin-tunnel')])
    const tunnel = await openTunnel(port, `127.0.0.1:${origin.port}`)
    const response = await tunnel.request(
      'POST /inside HTTP/1.1\r\nHost: origin\r\ncontent-length: 8\r\nConnection: close\r\n\r\ntunneled',
      'body=tunneled',
    )

    tunnel.close()

    expect(response).toContain('origin-tunnel /inside body=tunneled')
  })

  test('keeps concurrent tunnels isolated', async () => {
    const [{ port }, first, second] = await Promise.all([startProxy(), startOrigin('origin-one'), startOrigin('origin-two')])
    const [tunnelOne, tunnelTwo] = await Promise.all([
      openTunnel(port, `127.0.0.1:${first.port}`),
      openTunnel(port, `127.0.0.1:${second.port}`),
    ])
    const [responseOne, responseTwo] = await Promise.all([
      tunnelOne.request('GET /one HTTP/1.1\r\nHost: origin\r\nConnection: close\r\n\r\n', 'origin-one /one'),
      tunnelTwo.request('GET /two HTTP/1.1\r\nHost: origin\r\nConnection: close\r\n\r\n', 'origin-two /two'),
    ])

    tunnelOne.close()
    tunnelTwo.close()

    expect(responseOne).toContain('origin-one /one')
    expect(responseOne).not.toContain('origin-two')
    expect(responseTwo).toContain('origin-two /two')
    expect(responseTwo).not.toContain('origin-one')
  })

  test('denies clients outside the allowlist', async () => {
    const { port } = await startProxy({ ALLOW_IPS: '198.51.100.1/32' })
    const origin = await startOrigin('origin-denied')
    const response = await fetch(`http://127.0.0.1:${origin.port}/blocked`, {
      proxy: `http://127.0.0.1:${port}`,
    })

    expect(response.status).toBe(403)
    await expect(openTunnel(port, `127.0.0.1:${origin.port}`)).rejects.toThrow(/403/)
  })
})
