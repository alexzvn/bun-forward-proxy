export type IpRule = {
  value: bigint
  mask: bigint
  v4: boolean
}

const V4_MAPPED_PREFIX = '::ffff:'

export const normalizeIp = (ip: string): string => {
  const trimmed = ip.trim().toLowerCase()

  if (trimmed.startsWith(V4_MAPPED_PREFIX) && trimmed.includes('.')) {
    return trimmed.slice(V4_MAPPED_PREFIX.length)
  }

  return trimmed
}

const parseV4 = (ip: string): bigint | undefined => {
  const parts = ip.split('.')

  if (parts.length !== 4) return undefined

  let value = 0n

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined

    const octet = Number(part)

    if (octet > 255) return undefined

    value = (value << 8n) | BigInt(octet)
  }

  return value
}

const parseV6 = (ip: string): bigint | undefined => {
  const halves = ip.split('::')

  if (halves.length > 2) return undefined

  const expand = (chunk: string): string[] => (chunk.length === 0 ? [] : chunk.split(':'))

  const head = expand(halves[0] ?? '')
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : []
  const groups: string[] = []

  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length

    if (fill < 1) return undefined

    groups.push(...head, ...Array.from({ length: fill }, () => '0'), ...tail)
  } else {
    groups.push(...head)
  }

  if (groups.length !== 8) return undefined

  let value = 0n

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined

    value = (value << 16n) | BigInt(Number.parseInt(group, 16))
  }

  return value
}

export const parseIp = (ip: string): { value: bigint, v4: boolean } | undefined => {
  const normalized = normalizeIp(ip)

  if (normalized.includes('.') && !normalized.includes(':')) {
    const value = parseV4(normalized)

    return value === undefined ? undefined : { value, v4: true }
  }

  const value = parseV6(normalized)

  return value === undefined ? undefined : { value, v4: false }
}

export const parseRule = (raw: string): IpRule | undefined => {
  const [address, prefix] = raw.trim().split('/')

  if (!address) return undefined

  const parsed = parseIp(address)

  if (!parsed) return undefined

  const width = parsed.v4 ? 32 : 128
  const bits = prefix === undefined ? width : Number(prefix)

  if (!Number.isInteger(bits) || bits < 0 || bits > width) return undefined

  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits)

  return { value: parsed.value & mask, mask, v4: parsed.v4 }
}

export const parseRules = (raw: string | undefined): IpRule[] => {
  if (!raw) return []

  const rules: IpRule[] = []

  for (const entry of raw.split(/[\s,]+/)) {
    if (entry.length === 0) continue

    const rule = parseRule(entry)

    if (!rule) throw new Error(`invalid ALLOW_IPS entry: ${entry}`)

    rules.push(rule)
  }

  return rules
}

export const isAllowed = (ip: string | undefined, rules: IpRule[]): boolean => {
  if (rules.length === 0) return true
  if (!ip) return false

  const parsed = parseIp(ip)

  if (!parsed) return false

  return rules.some(rule => rule.v4 === parsed.v4 && (parsed.value & rule.mask) === rule.value)
}
