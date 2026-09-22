import express from 'express'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

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

function base64UrlToBuf(input) {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4
  if (pad === 2) b64 += '=='
  else if (pad === 3) b64 += '='
  else if (pad === 1) throw new Error('invalid base64url')
  return Buffer.from(b64, 'base64')
}

function decryptUrl(ciphertext) {
  if (typeof ciphertext === 'string' && ciphertext.startsWith('http')) return ciphertext
  const buf = base64UrlToBuf(ciphertext)
  if (buf.length < 28) throw new Error('ciphertext too short')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(12, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function isDecoyHost(url) {
  const u = url.toLowerCase()
  return u.includes('b-cdn.net') || u.includes('bunnycdn') || u.includes('mediadelivery.net')
}

async function playlistDurationSec(m3u8Url) {
  try {
    const res = await fetch(m3u8Url, {
      headers: {
        'User-Agent': UA,
        Referer: `${VIDROCK}/`,
        Origin: VIDROCK,
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return 0
    const text = await res.text()

    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const next = lines[i + 1]
          if (next && !next.startsWith('#')) {
            return playlistDurationSec(new URL(next, m3u8Url).href)
          }
        }
      }
      return 0
    }

    let total = 0
    for (const line of text.split('\n')) {
      const m = line.match(/^#EXTINF:([\d.]+)/)
      if (m) total += parseFloat(m[1])
    }
    return total
  } catch {
    return 0
  }
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return null
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${h}h ${m}m ${s}s`
}

async function imdbToTmdb(imdbId) {
  const res = await fetch(
    `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`
  )
  if (!res.ok) throw new Error(`TMDB ${res.status}`)
  const data = await res.json()
  if (data.movie_results?.[0]) return { kind: 'movie', id: String(data.movie_results[0].id) }
  if (data.tv_results?.[0]) return { kind: 'tv', id: String(data.tv_results[0].id) }
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

async function fetchCatalogViaPlaywright(apiPath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  })

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    })
    const page = await context.newPage()

    await page.goto(VIDROCK + '/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await page.waitForTimeout(3000)

    const title = await page.title()
    if (/just a moment/i.test(title)) {
      await page.waitForTimeout(5000)
    }

    const result = await page.evaluate(async (path) => {
      const r = await fetch('https://vidrock.net/api/' + path, {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Referer: 'https://vidrock.net/',
        },
      })
      const text = await r.text()
      return { status: r.status, text }
    }, apiPath)

    if (result.status !== 200) {
      throw new Error(`vidrock API ${result.status}: ${result.text.slice(0, 200)}`)
    }

    return JSON.parse(result.text)
  } finally {
    await browser.close()
  }
}

async function resolve(raw) {
  let parsed = parseInput(raw)
  if (!parsed) throw Object.assign(new Error('Could not parse id'), { status: 400 })

  if (parsed.needResolve) {
    const r = await imdbToTmdb(parsed.id)
    parsed =
      parsed.kind === 'tv'
        ? { ...parsed, id: r.id, needResolve: false }
        : { kind: r.kind, id: r.id, needResolve: false }
  }

  const apiPath =
    parsed.kind === 'tv'
      ? `tv/${parsed.id}/${parsed.season}/${parsed.episode}`
      : `movie/${parsed.id}`

  const payload = await fetchCatalogViaPlaywright(apiPath)

  const candidates = []
  for (const [name, entry] of Object.entries(payload || {})) {
    if (!entry || typeof entry !== 'object' || !entry.url) continue
    try {
      const url = decryptUrl(entry.url)
      if (isDecoyHost(url)) continue
      // Only full master playlists
      if (!/master\.m3u8/i.test(url)) continue
      candidates.push({
        name,
        url,
        format: entry.type === 'mp4' ? 'mp4' : 'hls',
        language: entry.language || null,
        flag: entry.flag || null,
      })
    } catch {
      // skip
    }
  }

  if (!candidates.length) {
    return { parsed, sources: [], note: 'No master.m3u8 sources found' }
  }

  const scored = await Promise.all(
    candidates.map(async (c) => {
      const durationSec = c.format === 'hls' ? await playlistDurationSec(c.url) : 0
      return {
        ...c,
        durationSec,
        duration: formatDuration(durationSec),
        proxyUrl:
          c.format === 'hls' ? `${WORKER}/?proxy=${encodeURIComponent(c.url)}` : null,
      }
    })
  )

  scored.sort((a, b) => (b.durationSec || 0) - (a.durationSec || 0))
  const longOnes = scored.filter((s) => (s.durationSec || 0) >= 30 * 60)
  const sources = longOnes.length ? longOnes : scored

  return { parsed, sources }
}

app.get('/', (_req, res) => {
  res.type('text').send(
    `Vidrock resolver\n\nGET /resolve?url=157336\nGET /resolve?url=tt0816692\n`
  )
})

app.get('/resolve', async (req, res) => {
  try {
    const raw = (req.query.url || '').toString().trim()
    if (!raw) return res.status(400).json({ error: 'Missing ?url=' })

    const { parsed, sources, note } = await resolve(raw)

    if (!sources.length) {
      return res.status(404).json({
        error: 'No playable sources',
        note: note || null,
        tmdbId: parsed.id,
      })
    }

    const best = sources[0]
    res.json({
      tmdbId: parsed.id,
      kind: parsed.kind,
      season: parsed.season || null,
      episode: parsed.episode || null,
      best: {
        name: best.name,
        url: best.url,
        duration: best.duration,
        durationSec: best.durationSec,
        proxyUrl: best.proxyUrl,
      },
      sources,
    })
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on 0.0.0.0:${PORT}`)
})
