import express from 'express'
import crypto from 'node:crypto'

const app = express()
const PORT = process.env.PORT || 3000

const VIDROCK = 'https://vidrock.net'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const AES_KEY = Buffer.from(
  '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f',
  'hex'
)
const TMDB_KEY = process.env.TMDB_KEY || '1f54bd990f1cdfb230adb312546d765d'
const WORKER = (process.env.WORKER_ORIGIN || 'https://vod.mmonterrosa970.workers.dev').replace(/\/$/, '')

// Simple cookie jar for this process
let cookieJar = ''

function browserHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${VIDROCK}/`,
    Origin: VIDROCK,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    ...(cookieJar ? { Cookie: cookieJar } : {}),
    ...extra,
  }
}

function mergeSetCookie(res) {
  const raw = res.headers.getSetCookie?.() || []
  if (!raw.length) {
    const single = res.headers.get('set-cookie')
    if (single) raw.push(single)
  }
  if (!raw.length) return
  const map = new Map()
  for (const part of (cookieJar ? cookieJar.split('; ') : [])) {
    const i = part.indexOf('=')
    if (i > 0) map.set(part.slice(0, i), part)
  }
  for (const sc of raw) {
    const first = sc.split(';')[0]
    const i = first.indexOf('=')
    if (i > 0) map.set(first.slice(0, i), first)
  }
  cookieJar = [...map.values()].join('; ')
}

/** Hit homepage so CF can set cookies before /api */
async function warmSession() {
  try {
    const res = await fetch(VIDROCK + '/', {
      headers: browserHeaders({
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      }),
      redirect: 'follow',
    })
    mergeSetCookie(res)
    await res.text()
  } catch (_) {
    // ignore warm failures
  }
}

function base64UrlToBuf(input) {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4
  if (pad === 2) b64 += '=='
  else if (pad === 3) b64 += '='
  else if (pad === 1) throw new Error('invalid base64url')
  return Buffer.from(b64, 'base64')
}

function decryptUrl(ciphertext) {
  if (typeof ciphertext === 'string' && ciphertext.startsWith('http')) {
    return ciphertext
  }
  const buf = base64UrlToBuf(ciphertext)
  if (buf.length < 28) throw new Error('ciphertext too short')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(12, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function isFullStream(url) {
  if (!url) return false
  const u = url.toLowerCase()
  if (u.includes('b-cdn.net') || u.includes('bunnycdn') || u.includes('mediadelivery.net')) {
    return false
  }
  return (
    u.includes('plasticprophecy.live') ||
    u.includes('cosmicalgorithm.live') ||
    u.includes('ngcorp.dad') ||
    u.includes('/master.m3u8') ||
    /\/file[123]\//.test(u) ||
    u.endsWith('.m3u8')
  )
}

async function imdbToTmdb(imdbId) {
  const res = await fetch(
    `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`
  )
  if (!res.ok) throw new Error(`TMDB ${res.status}`)
  const data = await res.json()
  if (data.movie_results?.[0]) {
    return { kind: 'movie', id: String(data.movie_results[0].id) }
  }
  if (data.tv_results?.[0]) {
    return { kind: 'tv', id: String(data.tv_results[0].id) }
  }
  throw new Error(`No TMDB match for ${imdbId}`)
}

function parseInput(raw) {
  let m = raw.match(/vidrock\.net\/(movie|tv)\/(tt\d+|\d+)(?:\/(\d+)\/(\d+))?/i)
  if (m) {
    const kind = m[1].toLowerCase()
    const id = m[2]
    if (kind === 'tv' && m[3] && m[4]) {
      return { kind: 'tv', id, season: +m[3], episode: +m[4], needResolve: /^tt/i.test(id) }
    }
    return { kind: 'movie', id, needResolve: /^tt/i.test(id) }
  }
  if (/^tt\d+$/i.test(raw)) return { kind: 'movie', id: raw, needResolve: true }
  if (/^\d+$/.test(raw)) return { kind: 'movie', id: raw, needResolve: false }
  m = raw.match(/^(\d+)\/(\d+)\/(\d+)$/)
  if (m) return { kind: 'tv', id: m[1], season: +m[2], episode: +m[3], needResolve: false }
  return null
}

async function fetchVidrockApi(path) {
  await warmSession()

  const res = await fetch(`${VIDROCK}/api/${path}`, {
    headers: browserHeaders({
      Referer: `${VIDROCK}/movie/${path.includes('tv/') ? '' : path.split('/')[1] || ''}`,
    }),
    redirect: 'follow',
  })
  mergeSetCookie(res)

  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`vidrock API ${res.status}`)
    err.status = res.status
    err.body = text.slice(0, 500)
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    const err = new Error('vidrock API non-JSON')
    err.body = text.slice(0, 500)
    throw err
  }
}

async function resolveSources(parsed) {
  if (parsed.needResolve) {
    const r = await imdbToTmdb(parsed.id)
    parsed =
      parsed.kind === 'tv'
        ? { ...parsed, id: r.id, needResolve: false }
        : { kind: r.kind, id: r.id, needResolve: false }
  }

  const path =
    parsed.kind === 'tv'
      ? `tv/${parsed.id}/${parsed.season}/${parsed.episode}`
      : `movie/${parsed.id}`

  const payload = await fetchVidrockApi(path)
  const sources = []

  for (const [name, entry] of Object.entries(payload || {})) {
    if (!entry || typeof entry !== 'object' || !entry.url) continue
    try {
      const url = decryptUrl(entry.url)
      if (!isFullStream(url)) continue
      sources.push({
        name,
        url,
        format: entry.type === 'mp4' ? 'mp4' : 'hls',
        language: entry.language || null,
        flag: entry.flag || null,
        proxyUrl:
          entry.type === 'mp4' ? null : `${WORKER}/?proxy=${encodeURIComponent(url)}`,
      })
    } catch {
      // skip
    }
  }
  return { parsed, sources }
}

app.get('/', (_req, res) => {
  res.type('text').send(
    `Vidrock resolver (Render)\n\nGET /resolve?url=157336\nGET /resolve?url=tt0816692\n`
  )
})

app.get('/resolve', async (req, res) => {
  try {
    const raw = (req.query.url || '').toString().trim()
    if (!raw) return res.status(400).json({ error: 'Missing ?url=' })

    const parsed = parseInput(raw)
    if (!parsed) return res.status(400).json({ error: 'Could not parse id' })

    const { parsed: p, sources } = await resolveSources(parsed)

    if (!sources.length) {
      return res.status(404).json({
        error: 'No full-length streams',
        tmdbId: p.id,
        hint: 'API may have returned decoys or nulls for this title',
      })
    }

    res.json({
      tmdbId: p.id,
      kind: p.kind,
      season: p.season || null,
      episode: p.episode || null,
      sources,
    })
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message,
      body: e.body || null,
      hint:
        e.status === 403
          ? 'Cloudflare is blocking this Render IP. Use Playwright fallback, a residential proxy, or deploy on Fly.io / a VPS.'
          : null,
    })
  }
})

app.listen(PORT, () => console.log(`listening on ${PORT}`))
