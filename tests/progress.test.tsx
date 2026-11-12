import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { addUsage, applyInput, applyPlan, carryOver } from '../hooks/register'
import { elapsedMs, infographic, usageText } from '../hooks/infographic'
import type { Board } from '../types'

const PANE = {
  plugin: 'progress-panel',
  component: 'Pane',
  requestId: 'progress',
  props: {
    title: '진행 경과',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TOOL = 'mcp__progress-panel__progress_update'

const seed = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    reset: true,
    title: '디스크 정리 & <정리>',
    disk: { beforeGB: 44, nowGB: 78, totalGB: 994 },
    steps: [
      { id: 'uv', label: 'uv 캐시', status: 'pending' },
      { id: 'vscode', label: 'VS Code 캐시', status: 'pending' },
    ],
  } as never)
  await $.tool.call({
    tool: TOOL,
    steps: [{ id: 'uv', status: 'done', freedGB: 23.1 }, { id: 'vscode', status: 'blocked', detail: '⌘Q 필요' }],
    note: 'Time Machine 스냅샷',
  } as never)
}

test('the terminal lists merged steps with status and freed space', async ($, on) => {
  await seed($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /완료/ }))?.text).toBe('1/2 완료 · 확보 23.1 GB')
  expect((await ui.find({ type: 'Text', text: /uv 캐시/ }))?.text).toBe('✓ uv 캐시  (23.1 GB)')
  expect((await ui.find({ type: 'Text', text: /VS Code/ }))?.text).toBe('! VS Code 캐시')
  expect((await ui.find({ type: 'Text', text: /여유 공간/ }))?.text).toBe('여유 공간 44 → 78 GB')
  await ui.unmount()
})

test('desktop and mobile draw one escaped SVG infographic', async ($, on) => {
  await seed($, on)
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svg = await ui.find({ type: 'Svg' })
    const source = String(svg?.props.source)
    expect(svg?.props.alt).toBe('디스크 정리 & <정리>: 1/2 완료 · 확보 23.1 GB')
    expect(source).toContain('디스크 정리 &amp; &lt;정리&gt;')
    expect(source).toContain('50%')
    expect(source).toContain('23.1')
    expect(source).toContain('⌘Q 필요')
    expect(source).toContain('Time Machine 스냅샷')
    expect(source).not.toContain('<정리>')
    await ui.unmount()
  }
})

test('update_plan calls replay into the task list the widget reads', async () => {
  let plan = applyPlan([], {
    items: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
    ],
  })
  plan = applyPlan(plan, { advance: true })
  expect(plan.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  plan = applyPlan(plan, { done: [2], start: 3 })
  expect(plan.map(i => i.status)).toEqual(['completed', 'completed', 'in_progress'])
})

test('a background launch counts at once and TaskStop drops it', async ($, on) => {
  const written: string[] = []
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '/home/u\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.write', (_, e) => {
    written.push(String((e as unknown as { text: string }).text))

    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work/proj' }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
  }))
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: { message: 'stopped' } }))

  await $.tool.call({ tool: 'Bash', command: 'python train.py', run_in_background: true } as never)
  const afterLaunch = JSON.parse(written.at(-1) ?? '{}') as { background?: { id: string }[] }
  expect(afterLaunch.background?.map(t => t.id)).toEqual(['b1'])

  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' } as never)
  const afterStop = JSON.parse(written.at(-1) ?? '{}') as { background?: unknown[] }
  expect(afterStop.background).toEqual([])
})

test('steps get start and end times, and the board its start', () => {
  const empty: Board = { title: '', steps: [], notes: [], updatedAt: '' }
  let b = applyInput(empty, { reset: true, steps: [{ id: 'a', label: 'A', status: 'running' }, { id: 'b', label: 'B' }] }, '2026-11-12T00:00:00.000Z')
  expect(b.startedAt).toBe('2026-11-12T00:00:00.000Z')
  expect(b.steps[0]?.startedAt).toBe('2026-11-12T00:00:00.000Z')
  b = applyInput(b, { steps: [{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }] }, '2026-11-12T00:10:00.000Z')
  expect(b.steps[0]?.endedAt).toBe('2026-11-12T00:10:00.000Z')
  expect(b.steps[1]?.startedAt).toBe('2026-11-12T00:10:00.000Z')
  // The clock runs while a step is open, then freezes at the last close.
  expect(elapsedMs(b, Date.parse('2026-11-12T00:25:00.000Z'))).toBe(25 * 60_000)
  b = applyInput(b, { steps: [{ id: 'b', status: 'done' }] }, '2026-11-12T00:30:00.000Z')
  expect(elapsedMs(b, Date.parse('2026-11-12T05:00:00.000Z'))).toBe(30 * 60_000)
  // A board saved before startedAt existed shows no clock instead of restarting it.
  const old = applyInput({ ...empty, steps: [{ id: 'x', label: 'X', status: 'running' }] }, { note: 'n' }, '2026-11-12T01:00:00.000Z')
  expect(old.startedAt).toBeUndefined()
})

test('responses are charged by model to the running step, else unassigned', () => {
  const u = (model: string, output: number) => ({
    model, input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
  })
  let b: Board = { title: '', steps: [{ id: 'a', label: 'A', status: 'pending' }], notes: [], updatedAt: '' }
  b = addUsage(b, u('claude-opus-5-5', 5))
  expect(b.unassigned?.['claude-opus-5-5']?.calls).toBe(1)
  b = { ...b, steps: [{ id: 'a', label: 'A', status: 'running' }] }
  b = addUsage(b, u('claude-opus-5-5', 2000))
  b = addUsage(b, u('claude-sonnet-5-5', 3000))
  b = addUsage(b, u('claude-opus-5-5', 1000))
  const opus = b.steps[0]?.usage?.['claude-opus-5-5']
  expect(opus).toEqual({ input: 20, output: 3000, cacheRead: 2000, cacheWrite: 0, calls: 2 })
  expect(usageText(b.steps[0]?.usage)).toBe('Opus 5.5 · 출력 3k · 전체 5k  /  Sonnet 5.5 · 출력 3k · 전체 4k')
  // A restart keeps the times and the tokens.
  const rebuilt = applyInput({ title: '', steps: [], notes: [], updatedAt: '' }, { steps: b.steps }, '2026-11-12T09:00:00.000Z')
  const back = carryOver(rebuilt, { ...b, startedAt: '2026-11-12T08:00:00.000Z' })
  expect(back.startedAt).toBe('2026-11-12T08:00:00.000Z')
  expect(back.steps[0]?.usage?.['claude-sonnet-5-5']?.output).toBe(3000)
  expect(back.unassigned?.['claude-opus-5-5']?.calls).toBe(1)
})

test('the header shows elapsed time and tokens, not freed space', () => {
  const b: Board = {
    title: 'T', notes: [], updatedAt: '', startedAt: '2026-11-12T00:00:00.000Z',
    steps: [{ id: 'a', label: 'A', status: 'running', startedAt: '2026-11-12T00:00:00.000Z',
      usage: { 'claude-opus-5-5': { input: 0, output: 4000, cacheRead: 96000, cacheWrite: 0, calls: 3 } } }],
  }
  const { source } = infographic(b, Date.parse('2026-11-12T01:05:00.000Z'))
  expect(source).toContain('경과 시간')
  expect(source).toContain('1시간 05분')
  expect(source).toContain('토큰 <tspan fill="#ffffff" font-weight="700">100k</tspan> · 출력 4k')
  expect(source).toContain('Opus 5.5 · 출력 4k · 전체 100k')
  expect(source).not.toContain('확보한 용량')
})

test('an empty board says so', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('아직 진행 중인 작업이 없습니다.')
    await ui.unmount()
  }
})
