// Draws the board as one SVG infographic for the surfaces that have `Svg`.
import type { Board, Step, StepStatus, TokenCount, UsageByModel } from '../types'

export const W = 360

const FONT = "Pretendard, -apple-system, 'Apple SD Gothic Neo', sans-serif"

type Tone = { from: string; to: string; glyph: string; label: string; text: string }

export const TONE: Record<StepStatus, Tone> = {
  done: { from: '#22c55e', to: '#14b8a6', glyph: '✓', label: '완료', text: '#e2e8f0' },
  running: { from: '#3b82f6', to: '#a855f7', glyph: '▶', label: '진행', text: '#ffffff' },
  blocked: { from: '#f59e0b', to: '#ef4444', glyph: '!', label: '조치 필요', text: '#fde68a' },
  pending: { from: '#64748b', to: '#475569', glyph: '○', label: '대기', text: '#94a3b8' },
  skipped: { from: '#475569', to: '#334155', glyph: '–', label: '건너뜀', text: '#64748b' },
}

const ORDER: StepStatus[] = ['done', 'running', 'blocked', 'pending']

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Width in units of a Latin glyph: CJK and other wide glyphs count about double.
const units = (s: string): number =>
  [...s].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 1.8 : 1), 0)

// Cuts text to fit `px` at font size `size`, ending in an ellipsis.
const clip = (s: string, px: number, size: number): string => {
  const max = px / (size * 0.55)
  if (units(s) <= max) return s
  let out = ''
  for (const c of s) {
    if (units(out + c) + 1 > max) break
    out += c
  }

  return `${out}…`
}

const gb = (n: number): string => (n >= 10 ? n.toFixed(0) : n.toFixed(1))

export const freedTotal = (b: Board): number =>
  b.steps.reduce((sum, s) => sum + (s.freedGB ?? 0), 0)

const isClosed = (s: Step): boolean => s.status === 'done' || s.status === 'skipped'

// "claude-opus-5-5" → "Opus 5.5"; an id it cannot read is shown as is.
export const modelName = (id: string): string => {
  const m = id.match(/(opus|sonnet|haiku|fable)[-_ ]?(\d+)?(?:[-_.](\d+))?/i)
  if (!m || m[1] === undefined) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()

  return m[2] !== undefined ? `${family} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}` : family
}

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const allIn = (t: TokenCount): number => t.input + t.cacheRead + t.cacheWrite + t.output

// Sums usage maps by model.
export const sumUsage = (maps: readonly (UsageByModel | undefined)[]): UsageByModel => {
  const out: UsageByModel = {}
  for (const m of maps) {
    for (const [model, t] of Object.entries(m ?? {})) {
      const p = out[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
      out[model] = {
        input: p.input + t.input,
        output: p.output + t.output,
        cacheRead: p.cacheRead + t.cacheRead,
        cacheWrite: p.cacheWrite + t.cacheWrite,
        calls: p.calls + t.calls,
      }
    }
  }

  return out
}

// "Opus 5.5 · 출력 6k · 전체 320k", one model after another.
export const usageText = (u: UsageByModel | undefined): string =>
  Object.entries(u ?? {})
    .sort((a, c) => allIn(c[1]) - allIn(a[1]))
    .map(([model, t]) => `${modelName(model)} · 출력 ${tokens(t.output)} · 전체 ${tokens(allIn(t))}`)
    .join('  /  ')

export const duration = (ms: number): string => {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '1분 미만'
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)

  return `${h}시간 ${String(min % 60).padStart(2, '0')}분`
}

// The board's running time: from its start to now, frozen at the last close
// once every step is done. Undefined for a board saved before startedAt.
export const elapsedMs = (b: Board, now: number): number | undefined => {
  if (b.startedAt === undefined) return undefined
  const start = Date.parse(b.startedAt)
  const finished = b.steps.length > 0 && b.steps.every(isClosed)
  const ends = b.steps.map(s => (s.endedAt === undefined ? NaN : Date.parse(s.endedAt))).filter(n => !Number.isNaN(n))
  const end = finished && ends.length > 0 ? Math.max(...ends) : now

  return Math.max(0, end - start)
}

const stepMs = (s: Step, now: number): number | undefined => {
  if (s.startedAt === undefined) return undefined
  const end = s.endedAt === undefined ? now : Date.parse(s.endedAt)

  return Math.max(0, end - Date.parse(s.startedAt))
}

const header = (b: Board, y: number, now: number): { svg: string; h: number } => {
  const total = b.steps.length
  const done = b.steps.filter(s => s.status === 'done').length
  const pct = total === 0 ? 0 : done / total
  const r = 32
  const c = 2 * Math.PI * r
  const finished = total > 0 && b.steps.every(isClosed)
  const elapsed = elapsedMs(b, now)
  const all = sumUsage([b.unassigned, ...b.steps.map(s => s.usage)])
  const totalTokens = Object.values(all).reduce((n, t) => n + allIn(t), 0)
  const totalOut = Object.values(all).reduce((n, t) => n + t.output, 0)
  const models = Object.keys(all).map(modelName).join(' · ')
  const disk = b.disk
  const tokenLine =
    totalTokens === 0
      ? ''
      : `<text x="132" y="${y + 106}" font-size="11" fill="#c7d2fe">토큰 <tspan fill="#ffffff" font-weight="700">${tokens(totalTokens)}</tspan> · 출력 ${tokens(totalOut)}</text>`
  const lastLine =
    disk !== undefined
      ? `<text x="132" y="${y + 121}" font-size="11" fill="#94a3b8">여유 공간 ` +
        `${disk.beforeGB !== undefined ? `<tspan fill="#cbd5e1">${gb(disk.beforeGB)}</tspan> → ` : ''}` +
        `<tspan fill="#5eead4" font-weight="700">${gb(disk.nowGB)} GB</tspan></text>`
      : models !== ''
        ? `<text x="132" y="${y + 121}" font-size="10.5" fill="#94a3b8">${esc(clip(models, W - 146, 10.5))}</text>`
        : ''

  return {
    h: 140,
    svg: `
  <rect x="0" y="${y}" width="${W}" height="132" rx="18" fill="url(#hdr)"/>
  <rect x="0" y="${y}" width="${W}" height="132" rx="18" fill="url(#shine)"/>
  <text x="18" y="${y + 28}" font-size="15" font-weight="700" fill="#ffffff">${esc(clip(b.title || '진행 경과', W - 36, 15))}</text>
  <g transform="translate(66 ${y + 84})">
    <circle r="${r}" fill="none" stroke="#ffffff1f" stroke-width="10"/>
    <circle r="${r}" fill="none" stroke="url(#ring)" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90)">
    </circle>
    <text y="4" text-anchor="middle" font-size="17" font-weight="800" fill="#ffffff">${Math.round(pct * 100)}%</text>
    <text y="19" text-anchor="middle" font-size="9.5" fill="#cbd5e1">${done}/${total} 단계</text>
  </g>
  <text x="132" y="${y + 56}" font-size="11" fill="#a5b4fc" letter-spacing="1">${finished ? '걸린 시간' : '경과 시간'}</text>
  <text x="130" y="${y + 88}" font-size="28" font-weight="800" fill="url(#gold)">${elapsed === undefined ? '—' : duration(elapsed)}</text>
  ${tokenLine}${lastLine}`,
  }
}

const chips = (b: Board, y: number): { svg: string; h: number } => {
  const gap = 6
  const w = (W - gap * (ORDER.length - 1)) / ORDER.length
  const parts = ORDER.map((st, i) => {
    const n = b.steps.filter(s => s.status === st).length
    const t = TONE[st]
    const x = i * (w + gap)

    return `
  <g opacity="${n === 0 ? 0.45 : 1}">
    <rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="40" rx="12" fill="url(#g-${st})" fill-opacity="0.18" stroke="url(#g-${st})" stroke-width="1.2"/>
    <text x="${(x + w / 2).toFixed(1)}" y="${y + 19}" text-anchor="middle" font-size="16" font-weight="800" fill="${t.from}">${n}</text>
    <text x="${(x + w / 2).toFixed(1)}" y="${y + 33}" text-anchor="middle" font-size="9.5" fill="#cbd5e1">${t.glyph} ${t.label}</text>
  </g>`
  })

  return { h: 52, svg: parts.join('') }
}

const sectionTitle = (text: string, y: number): string =>
  `<text x="2" y="${y + 13}" font-size="11.5" font-weight="700" fill="#e2e8f0" letter-spacing="0.5">${esc(text)}</text>
  <rect x="2" y="${y + 18}" width="24" height="2.5" rx="1.25" fill="url(#ring)"/>`

const diskGauge = (b: Board, y: number): { svg: string; h: number } => {
  const d = b.disk
  if (d === undefined) return { svg: '', h: 0 }
  const total = d.totalGB ?? Math.max(d.nowGB, d.beforeGB ?? 0) * 1.25
  const barW = W - 70
  const bar = (label: string, value: number, fill: string, yy: number, delay: string): string => {
    const w = Math.max(2, (value / total) * barW)

    return `
  <text x="2" y="${yy + 11}" font-size="10.5" fill="#94a3b8">${label}</text>
  <rect x="34" y="${yy}" width="${barW}" height="14" rx="7" fill="#ffffff12"/>
  <rect x="34" y="${yy}" width="${w.toFixed(1)}" height="14" rx="7" fill="${fill}"/>
  <text x="${(34 + barW + 6).toFixed(1)}" y="${yy + 11}" font-size="10.5" font-weight="700" fill="#e2e8f0">${gb(value)}</text>`
  }
  const before = d.beforeGB === undefined ? '' : bar('전', d.beforeGB, '#475569', y + 30, '0s')
  const nowY = d.beforeGB === undefined ? y + 30 : y + 52

  return {
    h: (d.beforeGB === undefined ? 52 : 74) + 8,
    svg: `${sectionTitle(`디스크 여유 공간 · 전체 ${gb(total)} GB`, y)}${before}${bar('후', d.nowGB, 'url(#g-done)', nowY, '0.2s')}`,
  }
}

const freedChart = (b: Board, y: number): { svg: string; h: number } => {
  const rows = b.steps
    .filter((s): s is Step & { freedGB: number } => (s.freedGB ?? 0) > 0)
    .sort((a, c) => c.freedGB - a.freedGB)
  if (rows.length === 0) return { svg: '', h: 0 }
  const max = rows[0]?.freedGB ?? 1
  const labelW = 112
  const barW = W - labelW - 46
  const palette = ['#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb7185']
  const parts = rows.map((s, i) => {
    const yy = y + 30 + i * 22
    const w = Math.max(3, (s.freedGB / max) * barW)
    const color = palette[i % palette.length] ?? '#60a5fa'

    return `
  <g><title>${esc(`${s.label}: ${s.freedGB} GB`)}</title>
    <text x="2" y="${yy + 11}" font-size="10.5" fill="#cbd5e1">${esc(clip(s.label, labelW - 6, 10.5))}</text>
    <rect x="${labelW}" y="${yy + 1}" width="${barW}" height="13" rx="6.5" fill="#ffffff0d"/>
    <rect x="${labelW}" y="${yy + 1}" width="${w.toFixed(1)}" height="13" rx="6.5" fill="${color}"/>
    <text x="${(labelW + w + 5).toFixed(1)}" y="${yy + 11}" font-size="10.5" font-weight="700" fill="${color}">${gb(s.freedGB)}</text>
  </g>`
  })

  return { h: 30 + rows.length * 22 + 10, svg: sectionTitle('단계별 확보 용량 (GB)', y) + parts.join('') }
}

const timeline = (b: Board, y: number, now: number): { svg: string; h: number } => {
  let yy = y + 32
  const rows: string[] = []
  const rowH = (s: Step): number => 26 + (s.detail ? 12 : 0) + (s.usage !== undefined ? 12 : 0)
  b.steps.forEach((s, i) => {
    const t = TONE[s.status]
    const h = rowH(s)
    const cy = yy + 9
    const next = b.steps[i + 1]
    const line =
      next === undefined
        ? ''
        : `<line x1="12" y1="${cy + 10}" x2="12" y2="${yy + h + 1}" stroke="${s.status === 'done' ? '#14b8a6' : '#334155'}" stroke-width="2" stroke-dasharray="${s.status === 'done' ? '0' : '3 3'}"/>`
    const pulse =
      s.status === 'running'
        ? `<circle cx="12" cy="${cy}" r="9" fill="none" stroke="${t.from}" stroke-width="2"><animate attributeName="r" values="9;14;9" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0;0.9" dur="1.6s" repeatCount="indefinite"/></circle>`
        : ''
    // Right side: freed space for a capacity step, else how long the step took.
    const ms = stepMs(s, now)
    const badge =
      s.freedGB !== undefined
        ? `<text x="${W - 2}" y="${cy + 4}" text-anchor="end" font-size="10.5" font-weight="700" fill="#fbbf24">+${gb(s.freedGB)} GB</text>`
        : ms !== undefined
          ? `<text x="${W - 2}" y="${cy + 4}" text-anchor="end" font-size="10" fill="${s.status === 'running' ? '#c4b5fd' : '#94a3b8'}">${duration(ms)}</text>`
          : ''
    const labelW = W - 34 - (badge !== '' ? 60 : 0)
    const detail = s.detail
      ? `<text x="30" y="${cy + 19}" font-size="10" fill="${s.status === 'blocked' ? '#fbbf24' : '#94a3b8'}">${esc(clip(s.detail, W - 32, 10))}</text>`
      : ''
    const usage =
      s.usage !== undefined
        ? `<text x="30" y="${cy + (s.detail ? 31 : 19)}" font-size="9.5" fill="#a5b4fc">${esc(clip(usageText(s.usage), W - 32, 9.5))}</text>`
        : ''
    const card =
      s.status === 'blocked'
        ? `<rect x="22" y="${yy - 3}" width="${W - 22}" height="${h - 2}" rx="9" fill="#f59e0b" fill-opacity="0.08" stroke="#f59e0b" stroke-opacity="0.35"/>`
        : ''
    rows.push(`
  <g><title>${esc(`${t.label} · ${s.label}${s.detail ? ` — ${s.detail}` : ''}${s.usage !== undefined ? `\n${usageText(s.usage)}` : ''}`)}</title>
    ${card}${line}${pulse}
    <circle cx="12" cy="${cy}" r="9" fill="url(#g-${s.status})"/>
    <text x="12" y="${cy + 3.6}" text-anchor="middle" font-size="10" font-weight="800" fill="#0b1020">${t.glyph}</text>
    <text x="30" y="${cy + 4}" font-size="12" font-weight="${s.status === 'running' ? 700 : 500}" fill="${t.text}"${s.status === 'skipped' ? ' text-decoration="line-through"' : ''}>${esc(clip(s.label, labelW, 12))}</text>
    ${badge}${detail}${usage}
  </g>`)
    yy += h
  })

  return { h: yy - y + 6, svg: sectionTitle('단계', y) + rows.join('') }
}

const notes = (b: Board, y: number): { svg: string; h: number } => {
  const list = b.notes.slice(-4)
  if (list.length === 0) return { svg: '', h: 0 }
  const h = 30 + list.length * 18
  const lines = list
    .map(
      (n, i) =>
        `<text x="14" y="${y + 40 + i * 18}" font-size="10.5" fill="#c7d2fe">◆ <tspan fill="#e2e8f0">${esc(clip(n, W - 40, 10.5))}</tspan></text>`,
    )
    .join('')

  return {
    h: h + 8,
    svg: `<rect x="0" y="${y + 4}" width="${W}" height="${h}" rx="12" fill="#6366f1" fill-opacity="0.10" stroke="#818cf8" stroke-opacity="0.35"/>
  <text x="14" y="${y + 22}" font-size="11" font-weight="700" fill="#a5b4fc">메모</text>${lines}`,
  }
}

const DEFS = `
  <defs>
    <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#312e81"/><stop offset="0.55" stop-color="#1e1b4b"/><stop offset="1" stop-color="#064e3b"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.85" cy="0" r="0.9">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.35"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
    ${(Object.keys(TONE) as StepStatus[])
      .map(
        st =>
          `<linearGradient id="g-${st}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TONE[st].from}"/><stop offset="1" stop-color="${TONE[st].to}"/></linearGradient>`,
      )
      .join('')}
  </defs>`

// Returns the SVG document and its height in viewBox units (width is W).
export const infographic = (b: Board, now = Date.now()): { source: string; height: number } => {
  const parts: string[] = []
  let y = 0
  for (const block of [header, chips, diskGauge, freedChart, timeline, notes]) {
    const { svg, h } = block(b, y, now)
    if (h === 0) continue
    parts.push(svg)
    y += h
  }
  const height = Math.ceil(y + 4)

  return {
    height,
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family="${FONT}">${DEFS}${parts.join('')}</svg>`,
  }
}
