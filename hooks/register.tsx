import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Disk, Step, StepStatus, UsageByModel } from '../types'
import { TONE, W, duration, elapsedMs, freedTotal, infographic, usageText } from './infographic'

const PANE = 'progress'
const TITLE = '진행 경과'
const TOOL = 'progress_update'
const STATUSES: readonly StepStatus[] = ['pending', 'running', 'done', 'skipped', 'blocked']
// The floating widget (widget/ProgressWidget.swift) reads every session's file here.
const SHARE_DIR = '.claude/progress-panel/sessions'
const WIDGET_APP = 'Applications/Progress Widget.app'

const EMPTY: Board = { title: '', steps: [], notes: [], updatedAt: '' }
// Change the tag when Board's fields change: it declines what an earlier
// version stored, which outlives a reload.
const board = atom({ plugin: 'progress-panel', key: 'board' } as const, EMPTY, {
  shape: 'board-2',
})

// The session's task list (update_plan), mirrored for the widget. Module
// variables start over on a reload; the next update_plan call fills them again.
type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }
let plan: PlanItem[] = []
// When the current task list began and, once every item is done, ended.
let planStartedAt: string | undefined
let planEndedAt: string | undefined
// Every API response of the session (main loop and subagents), by model,
// for the widget; the board's per-step usage is the pane's.
let sessionTokens: UsageByModel = {}
// Background work in flight (shells, subagents, monitors, workflows): added
// the moment a tool call launches one, dropped on TaskStop, and set to the
// Stop hook's own list at each turn's end, which also drops finished ones.
type BackgroundTask = { id: string; type: string; description: string }
let background: BackgroundTask[] = []

// True from a prompt or a tool call until the turn stops: a long turn that
// sends no task list still shows as working. Tool calls refresh the record
// at most once a minute, so a busy session never looks stale.
let busy = false
let lastBeat = 0
const BEAT_MS = 60 * 1000
// How often the pane redraws to move the elapsed-time counter.
const TICK_MS = 30 * 1000

const field = (v: unknown, key: string): string | undefined =>
  typeof v === 'object' && v !== null ? asText((v as Record<string, unknown>)[key]) : undefined

export const addBackground = (list: BackgroundTask[], task: BackgroundTask): BackgroundTask[] => [
  ...list.filter(t => t.id !== task.id),
  task,
]
let home: string | undefined

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '단계 고유 키 (예: "uv-cache")' },
    label: { type: 'string', description: '패널에 보일 이름' },
    status: { type: 'string', enum: STATUSES },
    detail: { type: 'string', description: '한 줄 설명 (선택)' },
    freedGB: { type: 'number', description: '이 단계로 확보한 용량 GB (선택)' },
  },
  required: ['id'],
}

const asText = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const asStatus = (v: unknown): StepStatus | undefined =>
  STATUSES.find(s => s === v)

// Merges one step patch into the list: a known id is updated, a new id is
// appended (it then needs a label, else the id is shown).
const mergeStep = (steps: Step[], raw: unknown): Step[] => {
  if (typeof raw !== 'object' || raw === null) return steps
  const p = raw as Record<string, unknown>
  const id = asText(p.id)
  if (!id) return steps
  const patch: Partial<Step> = {}
  const label = asText(p.label)
  const status = asStatus(p.status)
  const detail = asText(p.detail)
  const freedGB = asNumber(p.freedGB)
  if (label !== undefined) patch.label = label
  if (status !== undefined) patch.status = status
  if (detail !== undefined) patch.detail = detail
  if (freedGB !== undefined) patch.freedGB = freedGB
  const found = steps.some(s => s.id === id)
  if (found) return steps.map(s => (s.id === id ? { ...s, ...patch } : s))

  return [...steps, { id, label: label ?? id, status: status ?? 'pending', ...patch }]
}

// A disk patch needs nowGB; the other two fields keep what was there.
const mergeDisk = (prev: Disk | undefined, raw: unknown): Disk | undefined => {
  if (typeof raw !== 'object' || raw === null) return prev
  const p = raw as Record<string, unknown>
  const nowGB = asNumber(p.nowGB) ?? prev?.nowGB
  if (nowGB === undefined) return prev
  const beforeGB = asNumber(p.beforeGB) ?? prev?.beforeGB
  const totalGB = asNumber(p.totalGB) ?? prev?.totalGB

  return {
    nowGB,
    ...(beforeGB !== undefined ? { beforeGB } : {}),
    ...(totalGB !== undefined ? { totalGB } : {}),
  }
}

const isClosed = (s: Step): boolean => s.status === 'done' || s.status === 'skipped'

// Stamps when a step first runs and when it closes; reopening clears the end.
const stampTimes = (steps: Step[], now: string): Step[] =>
  steps.map(s => {
    let next = s
    if (s.status === 'running' && s.startedAt === undefined) next = { ...next, startedAt: now }
    if (isClosed(s) && s.endedAt === undefined) next = { ...next, endedAt: now }
    if (!isClosed(s) && s.endedAt !== undefined) {
      const { endedAt: _drop, ...rest } = next
      next = rest
    }

    return next
  })

export const applyInput = (prev: Board, input: Record<string, unknown>, now = new Date().toISOString()): Board => {
  const isReset = input.reset === true
  const base = isReset ? EMPTY : prev
  const title = asText(input.title) ?? base.title
  const merged = Array.isArray(input.steps) ? input.steps.reduce(mergeStep, base.steps) : base.steps
  const steps = stampTimes(merged, now)
  const note = asText(input.note)
  const notes = note ? [...base.notes, note].slice(-20) : base.notes
  const disk = mergeDisk(base.disk, input.disk)
  // A board from before startedAt existed keeps none (shown as "—") rather
  // than restarting the clock from this update.
  const startedAt = isReset || (base.steps.length === 0 && steps.length > 0) ? now : base.startedAt

  return {
    title,
    steps,
    notes,
    ...(disk ? { disk } : {}),
    updatedAt: now,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(base.unassigned !== undefined ? { unassigned: base.unassigned } : {}),
  }
}

// One API response's token use, as turn.step reports it.
export type ResponseUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const addTo = (byModel: UsageByModel | undefined, u: ResponseUsage): UsageByModel => {
  const prev = byModel?.[u.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }

  return {
    ...byModel,
    [u.model]: {
      input: prev.input + u.input_tokens,
      output: prev.output + u.output_tokens,
      cacheRead: prev.cacheRead + u.cache_read_input_tokens,
      cacheWrite: prev.cacheWrite + u.cache_creation_input_tokens,
      calls: prev.calls + 1,
    },
  }
}

// Charges one response to the first running step, or to the board's
// unassigned bucket while no step runs.
export const addUsage = (b: Board, u: ResponseUsage): Board => {
  const i = b.steps.findIndex(s => s.status === 'running')
  if (i < 0) return { ...b, unassigned: addTo(b.unassigned, u) }

  return { ...b, steps: b.steps.map((s, n) => (n === i ? { ...s, usage: addTo(s.usage, u) } : s)) }
}

// Replays one update_plan call: `items` replaces the list; `advance` completes
// the running item and starts the next pending one; `done`/`start` are 1-based.
export const applyPlan = (prev: PlanItem[], input: Record<string, unknown>): PlanItem[] => {
  let list = prev
  if (Array.isArray(input.items)) {
    list = input.items.flatMap(raw => {
      if (typeof raw !== 'object' || raw === null) return []
      const p = raw as Record<string, unknown>
      const content = asText(p.content)
      const status = p.status === 'in_progress' || p.status === 'completed' ? p.status : 'pending'

      return content ? [{ content, status }] : []
    })
  }
  if (input.advance === true) {
    const running = list.findIndex(i => i.status === 'in_progress')
    const nextIdx = list.findIndex((i, n) => n > running && i.status === 'pending')
    list = list.map((i, n) =>
      n === running ? { ...i, status: 'completed' } : n === nextIdx ? { ...i, status: 'in_progress' } : i,
    )
  }
  if (Array.isArray(input.done)) {
    const done = new Set(input.done.filter((n): n is number => typeof n === 'number'))
    list = list.map((i, n) => (done.has(n + 1) ? { ...i, status: 'completed' } : i))
  }
  const start = asNumber(input.start)
  if (start !== undefined) {
    list = list.map((i, n) =>
      n + 1 === start ? { ...i, status: 'in_progress' } : i.status === 'in_progress' ? { ...i, status: 'pending' } : i,
    )
  }

  return list
}

const summary = (b: Board): string => {
  const done = b.steps.filter(s => s.status === 'done').length
  const freed = freedTotal(b)

  return `${done}/${b.steps.length} 완료${freed > 0 ? ` · 확보 ${freed.toFixed(1)} GB` : ''}`
}

const homeDir = async ($: EngineInterface): Promise<string | undefined> => {
  if (home !== undefined) return home
  try {
    const { exitCode, stdout } = await $.process.run(['/usr/bin/printenv', 'HOME'])
    const dir = stdout.trim()
    if (exitCode === 0 && dir.startsWith('/')) home = dir
  } catch {
    // No process noun here (not a CLI host): the widget file is not written.
  }

  return home
}

// The model and the status line's figures (the plain usage call costs nothing).
// The engine gives no running input/output token totals, only the live context.
// Each figure is read on its own, so one that fails leaves the others; the
// failure's text goes along for the widget's tooltip.
const usageOf = async ($: EngineInterface) => {
  const errors: string[] = []
  const model = await $.session.model().catch((err: unknown) => {
    errors.push(`model: ${String(err)}`)

    return null
  })
  const u = await $.session.usage().catch((err: unknown) => {
    errors.push(`usage: ${String(err)}`)

    return null
  })

  return {
    model,
    contextTokens: u?.context?.tokens ?? null,
    contextWindow: u?.context?.window ?? null,
    contextPercent: u?.context?.percent ?? null,
    costUSD: u?.cost?.usd ?? null,
    rateLimits: (u?.rateLimits ?? []).map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt ?? null,
    })),
    ...(errors.length > 0 ? { errors } : {}),
  }
}

// Writes this session's progress for the floating widget; never fails a hook.
// `ended` marks a session that closed, which the widget then hides (there is no
// fs remove, so the file stays with the mark).
const share = async ($: EngineInterface, ended = false): Promise<void> => {
  try {
    const dir = await homeDir($)
    if (dir === undefined) return
    const [id, root, b] = await Promise.all([$.session.id(), $.session.root(), read($, board)])
    const project = root.split('/').filter(Boolean).pop() ?? root
    const body = {
      sessionId: id,
      project,
      root,
      updatedAt: new Date().toISOString(),
      ended,
      board: b,
      plan,
      background,
      busy: busy && !ended,
      usage: await usageOf($),
      tokens: sessionTokens,
      ...(planStartedAt !== undefined ? { planStartedAt } : {}),
      ...(planEndedAt !== undefined ? { planEndedAt } : {}),
    }
    await $.fs.write(`${dir}/${SHARE_DIR}/${id}.json`, JSON.stringify(body))
  } catch {
    // The widget is a convenience: a failed write leaves the pane as it is.
  }
}

// A list that opens with nothing open before restarts the clock; a list
// whose items are all done stops it, and reopening clears the stop.
const markPlanTimes = (wasOpen: boolean): void => {
  const now = new Date().toISOString()
  const isOpen = plan.some(i => i.status !== 'completed')
  if (isOpen && !wasOpen) {
    planStartedAt = now
    planEndedAt = undefined
  } else if (isOpen) {
    planEndedAt = undefined
  } else if (plan.length > 0 && planEndedAt === undefined) {
    planEndedAt = now
  }
}

// Puts back what applyInput does not rebuild from a saved board: the times
// and token use, so a restart neither restarts the clock nor loses tokens.
export const carryOver = (rebuilt: Board, saved: Partial<Board>): Board => {
  const byId = new Map((saved.steps ?? []).map(s => [s.id, s]))
  const steps = rebuilt.steps.map(s => {
    const old = byId.get(s.id)
    if (old === undefined) return s

    return {
      ...s,
      ...(asText(old.startedAt) !== undefined ? { startedAt: old.startedAt } : {}),
      ...(asText(old.endedAt) !== undefined && isClosed(s) ? { endedAt: old.endedAt } : {}),
      ...(old.usage !== undefined ? { usage: old.usage } : {}),
    }
  })
  const startedAt = asText(saved.startedAt)

  return {
    ...rebuilt,
    steps,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(saved.unassigned !== undefined ? { unassigned: saved.unassigned } : {}),
  }
}

// A restarted or resumed session picks up what its last process wrote: the
// app quitting ends every session, and the same id comes back on reopening.
const restore = async ($: EngineInterface): Promise<void> => {
  try {
    const dir = await homeDir($)
    if (dir === undefined) return
    const id = await $.session.id()
    const path = `${dir}/${SHARE_DIR}/${id}.json`
    if (!(await $.fs.exists(path))) return
    const saved = JSON.parse(await $.fs.read(path)) as {
      plan?: unknown
      board?: unknown
      tokens?: unknown
      planStartedAt?: unknown
      planEndedAt?: unknown
    }
    if (plan.length === 0 && Array.isArray(saved.plan)) plan = applyPlan([], { items: saved.plan })
    if (Object.keys(sessionTokens).length === 0 && typeof saved.tokens === 'object' && saved.tokens !== null) {
      sessionTokens = saved.tokens as UsageByModel
    }
    planStartedAt ??= asText(saved.planStartedAt)
    planEndedAt ??= asText(saved.planEndedAt)
    const prev = saved.board as Partial<Board> | undefined
    if (prev && Array.isArray(prev.steps) && prev.steps.length > 0) {
      await update($, board, now =>
        now.steps.length > 0
          ? now
          : carryOver(
              applyInput(EMPTY, {
                title: prev.title,
                steps: prev.steps,
                ...(prev.disk ? { disk: prev.disk } : {}),
              }),
              prev,
            ),
      )
    }
  } catch {
    // An unreadable record starts the session afresh.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: '진행 경과 패널을 연다',
    })
    await $.command.register({
      name: 'progress-widget',
      description: '모든 세션의 진행 경과를 떠 있는 창으로 연다',
    })
    await $.tool.register({
      name: TOOL,
      description:
        '진행 경과 패널을 갱신한다. steps 의 각 항목은 id 로 합쳐진다(없으면 추가, 있으면 바꾼 필드만 갱신). ' +
        'reset: true 는 새 작업을 시작할 때 이전 내용을 지운다. note 는 패널 아래에 한 줄 메모로 쌓인다. ' +
        'disk 는 디스크 여유 공간(작업 전·지금·전체 GB)을 막대로 보여 준다. 패널이 닫혀 있으면 연다.',
      inputSchema: {
        type: 'object',
        properties: {
          reset: { type: 'boolean', description: '이전 내용을 지우고 새로 시작' },
          title: { type: 'string', description: '작업 제목' },
          steps: { type: 'array', items: STEP_SCHEMA },
          note: { type: 'string', description: '메모 한 줄 (선택)' },
          disk: {
            type: 'object',
            description: '디스크 여유 공간 GB (측정값만)',
            properties: {
              beforeGB: { type: 'number', description: '작업 전 여유 공간' },
              nowGB: { type: 'number', description: '지금 여유 공간' },
              totalGB: { type: 'number', description: '디스크 전체 용량' },
            },
            required: ['nowGB'],
          },
        },
      },
      isDeferred: false,
    })

    const ran = await next(e)
    // Back on the widget at once, the earlier lists restored.
    await restore($)
    await share($)
    // The SVG draws in a script-less frame and redraws only on state changes,
    // so the elapsed time is kept counting by asking for a redraw (no writes).
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))

    return ran
  })

  // Every API response, charged to the running step by model. No share() here:
  // this fires per response, and the widget record is refreshed at turn end.
  // A streaming event: the chunks pass through untouched (`yield*`), and the
  // result's usage is read once the response has finished.
  on('turn.step', async function* ($, e, next) {
    const ran = yield* next(e)
    try {
      const u = ran.usage
      if (u !== null) {
        sessionTokens = addTo(sessionTokens, u)
        await update($, board, b => (b.steps.length > 0 ? addUsage(b, u) : b))
      }
    } catch {
      // Bookkeeping never fails the step that already ran.
    }

    return ran
  })

  // The turn's end lists the background work still in flight; a task that
  // finishes later wakes the session, whose next Stop updates the count.
  on('prompt.submit', async ($, e, next) => {
    busy = true
    lastBeat = Date.now()
    void share($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Every tool call: the heartbeat of a working turn.
  on('tool.call', async ($, e, next) => {
    const now = Date.now()
    if (!busy || now - lastBeat > BEAT_MS) {
      busy = true
      lastBeat = now
      void share($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const ran = await next(e)
    busy = false
    background = (e.background_tasks ?? [])
      .filter(t => t.status === 'running' || t.status === 'pending')
      .map(t => ({ id: t.id, type: t.type, description: t.description.slice(0, 120) }))
    await share($)

    return ran
  }).catch(($, e, next) => next(e))

  // A launch counts at once, without waiting for the turn to end.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined ? field(ran.result, 'backgroundTaskId') : undefined
    if (id !== undefined) {
      const input = e as unknown as Record<string, unknown>
      const description = asText(input.description) ?? asText(input.command) ?? 'shell'
      background = addBackground(background, { id, type: 'shell', description: description.slice(0, 120) })
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined ? field(ran.result, 'taskId') : undefined
    if (id !== undefined) {
      const description = asText((e as unknown as Record<string, unknown>).description) ?? 'monitor'
      background = addBackground(background, { id, type: 'monitor', description: description.slice(0, 120) })
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined ? field(ran.result, 'taskId') : undefined
    if (id !== undefined) {
      const input = e as unknown as Record<string, unknown>
      const description = field(ran.result, 'workflowName') ?? asText(input.name) ?? 'workflow'
      background = addBackground(background, { id, type: 'workflow', description: description.slice(0, 120) })
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A subagent counts only when it was sent to the background.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as Record<string, unknown>
    const isBackground = input.run_in_background === true || field(ran.result, 'status') === 'async_launched'
    const id = ran.deny === undefined && isBackground ? field(ran.result, 'agentId') : undefined
    if (id !== undefined) {
      const description = asText(input.description) ?? 'subagent'
      background = addBackground(background, { id, type: 'subagent', description: description.slice(0, 120) })
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as Record<string, unknown>
    const id = asText(input.task_id) ?? asText(input.shell_id)
    if (ran.deny === undefined && ran.isError !== true && id !== undefined) {
      background = background.filter(t => t.id !== id)
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Refreshes the token and cost figures once a turn is answered.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await share($)

    return ran
  })

  on('session.end', async ($, e, next) => {
    await share($, true)

    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    const b = await read($, board)
    $.ui.status(b.steps.length > 0 ? `${TITLE}: ${summary(b)}` : undefined)

    return {
      text: isPlaced
        ? '진행 경과 패널을 열었습니다.'
        : `이 화면에는 패널 자리가 없습니다(isPlaced=false). 상태 줄에 요약을 띄웠습니다: ${summary(b)}`,
    }
  })

  on('command.run', { command: 'progress-widget' }, async $ => {
    const dir = await homeDir($)
    if (dir === undefined) return { text: '홈 폴더를 찾지 못해 위젯을 열 수 없습니다.' }
    const app = `${dir}/${WIDGET_APP}`
    if (!(await $.fs.exists(app))) {
      return { text: `위젯 앱이 없습니다: ${app} — mod 폴더의 widget/build.sh 로 만드세요.` }
    }
    const { exitCode, stderr } = await $.process.run(['/usr/bin/open', app])

    return { text: exitCode === 0 ? '진행 경과 위젯을 열었습니다.' : `위젯을 열지 못했습니다: ${stderr.trim()}` }
  })

  on('tool.call', { tool: 'mcp__progress-panel__progress_update' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    await update($, board, prev => applyInput(prev, input))
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    const now = await read($, board)
    // Where no surface seats the pane, the status line still carries the summary.
    $.ui.status(`${TITLE}: ${summary(now)}`)
    await share($)

    return { result: `패널 갱신: ${summary(now)} (isPlaced=${isPlaced})` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: 패널 갱신에 실패했습니다.` },
  )

  // Mirrors the app's task list so every session shows up in the widget, even
  // one that never calls progress_update.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const wasOpen = plan.some(i => i.status !== 'completed')
      plan = applyPlan(plan, e as unknown as Record<string, unknown>)
      markPlanTimes(wasOpen)
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // wrap_up checks off the task list.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const ran = await next(e)
    if (plan.length > 0) {
      plan = plan.map(i => ({ ...i, status: 'completed' }))
      markPlanTimes(true)
      await share($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const b = await read($, board)

    if (e.surface !== 'terminal') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      if (b.steps.length === 0) {
        return (
          <Box flexDirection="column">
            <Text dimColor>아직 진행 중인 작업이 없습니다.</Text>
          </Box>
        )
      }
      const { source, height } = infographic(b, Date.now())
      const width = Math.max(300, Math.min(640, e.props.bodyColumns * 8))

      return (
        <Box flexDirection="column">
          <Svg
            source={source}
            alt={`${b.title || TITLE}: ${summary(b)}`}
            width={width}
            height={Math.round((height * width) / W)}
            isInteractive
          />
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 6)
    if (b.steps.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>아직 진행 중인 작업이 없습니다.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {b.title !== '' && <Text bold>{b.title}</Text>}
        <Text dimColor>{summary(b)}</Text>
        {elapsedMs(b, Date.now()) !== undefined && (
          <Text dimColor>경과 {duration(elapsedMs(b, Date.now()) ?? 0)}</Text>
        )}
        {b.disk !== undefined && (
          <Text dimColor>
            여유 공간 {b.disk.beforeGB !== undefined ? `${b.disk.beforeGB} → ` : ''}
            {b.disk.nowGB} GB
          </Text>
        )}
        <Text> </Text>
        {b.steps.slice(0, room).map(s => (
          <Box flexDirection="column">
            <Text
              color={s.status === 'blocked' ? 'yellow' : s.status === 'done' ? 'green' : undefined}
              dimColor={s.status === 'skipped'}
              bold={s.status === 'running'}
            >
              {TONE[s.status].glyph} {s.label}
              {s.freedGB !== undefined ? `  (${s.freedGB.toFixed(1)} GB)` : ''}
            </Text>
            {s.detail !== undefined && <Text dimColor>   {s.detail}</Text>}
            {s.usage !== undefined && <Text dimColor>   {usageText(s.usage)}</Text>}
          </Box>
        ))}
        {b.notes.length > 0 && <Text> </Text>}
        {b.notes.slice(-5).map(n => (
          <Text dimColor>· {n}</Text>
        ))}
      </Box>
    )
  })
}
