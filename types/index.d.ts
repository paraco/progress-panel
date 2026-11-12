export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'blocked'

// The four token counts of the API responses charged to one model.
export type TokenCount = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
}

// Token use keyed by the model id the API reported.
export type UsageByModel = Record<string, TokenCount>

export type Step = {
  id: string
  label: string
  status: StepStatus
  detail?: string
  freedGB?: number
  // ISO times: first turned running, and turned done/skipped.
  startedAt?: string
  endedAt?: string
  usage?: UsageByModel
}

// Free space before the work and now, in GB; totalGB scales the gauge.
export type Disk = {
  beforeGB?: number
  nowGB: number
  totalGB?: number
}

export type Board = {
  title: string
  steps: Step[]
  notes: string[]
  disk?: Disk
  updatedAt: string
  // When the board began (reset or first step); absent on boards from before.
  startedAt?: string
  // Responses that came while no step was running.
  unassigned?: UsageByModel
}

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': { board: Shaped<Board> }
  }
}
