import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  CodingNsAgentEvent,
  CodingNsCliTurnInput,
  CodingNsSubagentConversation,
  CodingNsSubagentSummary,
  CodingNsSubagentToolRecord,
  CodingNsSubagentTurn,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliAdapterRegistry } from './registry.js'

type SubagentDriver = Pick<CodingNsCliAdapterRegistry, 'runSubagentTurn'>
type Status = CodingNsSubagentConversation['status']
interface MutableTool {
  id: string
  name: string
  status: CodingNsSubagentToolRecord['status']
  input?: string
  output?: string
  error?: string
}
interface MutableTurn {
  id: string
  prompt: string
  text: string
  reasoning: string
  tools: MutableTool[]
  startedAt: string
  endedAt?: string
  usageSummary?: string
}
interface MutableConversation {
  id: string
  parentSessionId?: string
  adapterId: string
  modelId?: string
  cwd?: string
  providerSessionId?: string
  status: Status
  error?: string
  createdAt: string
  updatedAt: string
  turns: MutableTurn[]
}

export interface CodingNsSubagentRunRequest {
  readonly adapterId: string
  readonly prompt: string
  readonly parentSessionId?: string
  readonly cwd?: string
  readonly modelId?: string
  readonly signal?: AbortSignal
}

export interface CodingNsSubagentRunResult {
  readonly childSessionId: string
  readonly agent: string
  readonly ok: boolean
  readonly result: string
  readonly providerSessionId?: string
  readonly toolCalls: number
  readonly usageSummary?: string
  /** 后台启动时为 true；result 是占位说明，真实结果写入对话记录与面板。 */
  readonly background?: boolean
}

const MAX_CONVERSATIONS = 100
const MAX_TEXT_LENGTH = 200_000
const WRITE_DELAY_MS = 400

/** 独立外部进程没有 DSH Agent 句柄；为它们保存真实的流事件对话。 */
export class CodingNsSubagentConversations {
  private readonly conversations = new Map<string, MutableConversation>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly filePath: string
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly driver: SubagentDriver, filePath?: string) {
    this.filePath = filePath ?? join(process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh'), 'subagent-conversations.json')
    try {
      const persisted: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (Array.isArray(persisted)) {
        for (const value of persisted) {
          const conversation = hydrateConversation(value)
          if (conversation !== undefined) this.conversations.set(conversation.id, conversation)
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') console.warn('codingns4dsh: 子代理对话记录读取失败', error)
    }
    for (const conversation of this.conversations.values()) {
      if (conversation.status !== 'running') continue
      conversation.status = 'cancelled'
      conversation.error = 'DSH 已重启，先前的子代理运行已中断'
      conversation.updatedAt = new Date().toISOString()
      const last = conversation.turns.at(-1)
      if (last !== undefined && last.endedAt === undefined) last.endedAt = conversation.updatedAt
      this.scheduleWrite()
    }
  }

  list(parentSessionId?: string): CodingNsSubagentSummary[] {
    return [...this.conversations.values()]
      .filter((conversation) => parentSessionId === undefined || conversation.parentSessionId === parentSessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ turns, ...conversation }) => ({
        ...conversation,
        title: turns[0]?.prompt.slice(0, 100) ?? conversation.adapterId,
        turnCount: turns.length,
      }))
  }

  get(id: string): CodingNsSubagentConversation | undefined {
    const conversation = this.conversations.get(id)
    return conversation === undefined ? undefined : JSON.parse(JSON.stringify(conversation)) as CodingNsSubagentConversation
  }

  async run(request: CodingNsSubagentRunRequest, options: { readonly background?: boolean } = {}): Promise<CodingNsSubagentRunResult> {
    const now = new Date().toISOString()
    const id = `subagent-${randomUUID()}`
    const conversation: MutableConversation = {
      id,
      adapterId: request.adapterId,
      ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      status: 'running',
      createdAt: now,
      updatedAt: now,
      turns: [],
    }
    this.conversations.set(id, conversation)
    this.prune()
    this.scheduleWrite()
    if (options.background === true) {
      // 真后台：立即返回，回合在后台推进；结果与错误写入对话记录，
      // 面板/后续轮次可随时读取。主会话的流式输出不被阻塞。
      void this.runTurn(conversation, request.prompt, request.signal)
        .catch(() => { /* 错误已写入对话状态，供面板与 get 读取。 */ })
      return {
        childSessionId: id,
        agent: conversation.adapterId,
        ok: true,
        background: true,
        result: `子代理已在后台启动（${conversation.adapterId}）。结果稍后写入其对话记录；用 subagents/list 查看状态，或提醒用户在"子代理对话"面板查看。`,
        toolCalls: 0,
      }
    }
    return this.runTurn(conversation, request.prompt, request.signal)
  }

  followUp(id: string, prompt: string): { readonly accepted: true; readonly childSessionId: string } {
    const conversation = this.requireConversation(id)
    if (conversation.status === 'running') throw new Error('子代理正在运行，请等待当前消息完成')
    if (conversation.providerSessionId === undefined) throw new Error('外部 Agent 没有可恢复的会话标识')
    if (prompt.trim() === '') throw new Error('消息不能为空')
    conversation.status = 'running'
    delete conversation.error
    this.scheduleWrite()
    void this.runTurn(conversation, prompt).catch(() => { /* 错误已写入对话，供面板读取。 */ })
    return { accepted: true, childSessionId: id }
  }

  interrupt(id: string): { readonly interrupted: boolean } {
    this.requireConversation(id)
    const controller = this.controllers.get(id)
    if (controller === undefined) return { interrupted: false }
    controller.abort()
    return { interrupted: true }
  }

  async dispose(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort()
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
      this.queueWrite()
    }
    await this.writeTail
  }

  private async runTurn(conversation: MutableConversation, prompt: string, outerSignal?: AbortSignal): Promise<CodingNsSubagentRunResult> {
    const turn: MutableTurn = {
      id: randomUUID(), prompt, text: '', reasoning: '', tools: [], startedAt: new Date().toISOString(),
    }
    conversation.turns.push(turn)
    conversation.status = 'running'
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (outerSignal?.aborted) controller.abort()
    else outerSignal?.addEventListener('abort', abort, { once: true })
    this.controllers.set(conversation.id, controller)
    this.touch(conversation)
    let finishReason: 'stop' | 'cancel' | 'error' | undefined
    try {
      const input: CodingNsCliTurnInput & { adapterId: string } = {
        adapterId: conversation.adapterId,
        sessionId: conversation.id,
        prompt,
        messages: [],
        signal: controller.signal,
        ...(conversation.cwd ? { cwd: conversation.cwd } : {}),
        ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
        ...(conversation.providerSessionId ? { providerSessionId: conversation.providerSessionId } : {}),
      }
      for await (const event of this.driver.runSubagentTurn(input)) {
        this.applyEvent(conversation, turn, event)
        if (event.type === 'finish') finishReason = event.reason
      }
      conversation.status = controller.signal.aborted || finishReason === 'cancel' ? 'cancelled' : finishReason === 'stop' ? 'idle' : 'error'
      if (conversation.status === 'error') conversation.error = finishReason === 'error' ? '外部 Agent 报告执行失败' : '外部 Agent 未报告完成状态'
      return {
        childSessionId: conversation.id,
        agent: conversation.adapterId,
        ok: conversation.status === 'idle',
        result: turn.text.trim() === '' ? '(子代理没有文本输出)' : turn.text,
        ...(conversation.providerSessionId ? { providerSessionId: conversation.providerSessionId } : {}),
        toolCalls: turn.tools.filter((tool) => tool.status === 'completed' || tool.status === 'failed').length,
        ...(turn.usageSummary ? { usageSummary: turn.usageSummary } : {}),
      }
    } catch (error) {
      conversation.status = controller.signal.aborted ? 'cancelled' : 'error'
      conversation.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      turn.endedAt = new Date().toISOString()
      outerSignal?.removeEventListener('abort', abort)
      this.controllers.delete(conversation.id)
      this.touch(conversation)
      await this.flush()
    }
  }

  private applyEvent(conversation: MutableConversation, turn: MutableTurn, event: CodingNsAgentEvent): void {
    switch (event.type) {
      case 'session-binding': conversation.providerSessionId = event.providerSessionId; break
      case 'text-delta': turn.text = appendLimited(turn.text, event.text); break
      case 'text-snapshot': turn.text = limit(event.text); break
      case 'reasoning-delta': turn.reasoning = appendLimited(turn.reasoning, event.text); break
      case 'reasoning-snapshot': turn.reasoning = limit(event.text); break
      case 'tool-event': {
        const id = event.callId ?? `${turn.tools.length}-${event.toolName}`
        let tool = turn.tools.find((item) => item.id === id)
        if (tool === undefined) {
          tool = { id, name: event.toolName, status: event.status ?? 'running' }
          turn.tools.push(tool)
        }
        tool.status = event.status ?? tool.status
        if (event.input !== undefined) tool.input = limit(event.input)
        if (event.output !== undefined) tool.output = event.outputMode === 'delta' ? appendLimited(tool.output ?? '', event.output) : limit(event.output)
        if (event.error !== undefined) tool.error = limit(event.error)
        break
      }
      case 'usage': turn.usageSummary = summarizeUsage(event); break
    }
    this.touch(conversation)
  }

  private requireConversation(id: string): MutableConversation {
    const conversation = this.conversations.get(id)
    if (conversation === undefined) throw new Error('子代理对话不存在')
    return conversation
  }

  private touch(conversation: MutableConversation): void {
    conversation.updatedAt = new Date().toISOString()
    this.scheduleWrite()
  }

  private prune(): void {
    if (this.conversations.size <= MAX_CONVERSATIONS) return
    const old = [...this.conversations.values()]
      .filter((conversation) => conversation.status !== 'running')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    for (const conversation of old) {
      if (this.conversations.size <= MAX_CONVERSATIONS) break
      this.conversations.delete(conversation.id)
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== undefined) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      this.queueWrite()
    }, WRITE_DELAY_MS)
    this.writeTimer.unref?.()
  }

  private queueWrite(): void {
    const snapshot = JSON.stringify([...this.conversations.values()])
    this.writeTail = this.writeTail.catch(() => undefined).then(async () => {
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.filePath)
    }).catch((error) => { console.warn('codingns4dsh: 子代理对话记录写入失败', error) })
  }
}

function limit(text: string): string { return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH)}\n[输出已截断]` }
function appendLimited(current: string, delta: string): string { return current.includes('[输出已截断]') ? current : limit(current + delta) }
function summarizeUsage(usage: Extract<CodingNsAgentEvent, { type: 'usage' }>): string {
  const parts = [`输入 ${usage.inputTokens}`, `输出 ${usage.outputTokens}`]
  if (usage.totalTokens !== undefined) parts.push(`共 ${usage.totalTokens}`)
  return parts.join(' / ')
}

function hydrateConversation(value: unknown): MutableConversation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.adapterId !== 'string' || typeof record.createdAt !== 'string' || !Array.isArray(record.turns)) return undefined
  const turns: MutableTurn[] = record.turns.flatMap((candidate: unknown) => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const item = candidate as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.prompt !== 'string' || typeof item.startedAt !== 'string') return []
    return [{
      id: item.id, prompt: item.prompt, text: typeof item.text === 'string' ? item.text : '',
      reasoning: typeof item.reasoning === 'string' ? item.reasoning : '',
      tools: Array.isArray(item.tools) ? item.tools.filter((tool: unknown) => typeof tool === 'object' && tool !== null && typeof (tool as Record<string, unknown>).name === 'string') as MutableTool[] : [],
      startedAt: item.startedAt,
      ...(typeof item.endedAt === 'string' ? { endedAt: item.endedAt } : {}),
      ...(typeof item.usageSummary === 'string' ? { usageSummary: item.usageSummary } : {}),
    }]
  })
  const status: Status = record.status === 'running' || record.status === 'idle' || record.status === 'error' || record.status === 'cancelled' ? record.status : 'error'
  return {
    id: record.id, adapterId: record.adapterId, status, createdAt: record.createdAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : record.createdAt,
    turns,
    ...(typeof record.parentSessionId === 'string' ? { parentSessionId: record.parentSessionId } : {}),
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.modelId === 'string' ? { modelId: record.modelId } : {}),
    ...(typeof record.providerSessionId === 'string' ? { providerSessionId: record.providerSessionId } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}
