import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import type { CodingNsNativeTeamProxy } from './native-team-proxy.js'
import { getAdapterRegistry, getNativeSubagents, getSubagentConversations } from './registry-holder.js'
import type { NativeSubagentService } from './native-team-subagent.js'
import { EXTERNAL_SUBAGENT_IDS, externalTeamProvider, withTeamSubagentSelection } from './native-team-subagent.js'

/**
 * 外部 Agent 子代理的工具参数。adapterId 使用 cli/catalog 暴露的稳定 id，
 * 除了 DSH 默认 Agent（dsh）之外的全部外部适配器都可以作为子代理被派发。
 */
const SUBAGENT_TIMEOUT_MS = 15 * 60_000

interface NativeTeamOptions {
  readonly nativeTeam?: CodingNsNativeTeamProxy | undefined
  readonly nativeSessions?: CodingNsNativeSessionBridge | undefined
}

/**
 * 构造 `agent_subagent` 工具定义。
 *
 * 形状对齐 `@deepseek-ai/dsh-tools` 的 defineTool 产物（tools.register 只校验
 * name 与 output，execute 由 agent-loop 以 (args, exec) 调用），因此这里直接
 * 提供普通对象，不为插件引入对应用运行时包的构建期依赖。
 */
export function createAgentSubagentTool(options: NativeTeamOptions = {}): Record<string, unknown> {
  return {
    name: 'agent_subagent',
    description:
      '把一个自成体系的子任务派发给外部编码 Agent（Claude Code、Codex、Antigravity 等）执行。'
      + '默认等待完成并拿回最终结果（Teams 可用时作为成员运行，点击成员可打开原生对话续聊）；'
      + 'run_in_background=true 时立即返回后台任务标识，不阻塞主会话——适合并行派发多个互不依赖的子任务，'
      + '结果稍后通过 subagents/list 或"子代理对话"面板获取。'
      + '子任务在该 Agent 自己的上下文、工具链和模型账号中独立运行，不会继承主对话历史，因此 prompt 必须自包含（目标、涉及文件、完成标准）。'
      + '适合外包边界清晰的实现类子任务；需要共享主对话上下文或主 Agent 自己的工具（如当前会话记忆）时不要使用。',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: [...EXTERNAL_SUBAGENT_IDS],
          description: '子代理使用的外部 Agent id（cli/catalog 中 installed=true 的适配器）。',
        },
        prompt: {
          type: 'string',
          description: '子任务的完整、自包含描述：目标、涉及文件路径、完成标准。',
        },
        cwd: {
          type: 'string',
          description: '子任务的工作目录；Agent Teams 模式下必须与当前会话工作目录相同。',
        },
        model: {
          type: 'string',
          description: '可选；覆盖该 Agent 的模型选择（使用该 Agent 模型目录中的 id）。',
        },
        run_in_background: {
          type: 'boolean',
          description: '默认 false（等待结果）。true 时立即返回后台任务标识、不阻塞主会话；结果写入子代理对话记录，稍后查询。',
        },
      },
      required: ['agent', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          ok: { type: 'boolean', description: '回合是否正常完成' },
          result: { type: 'string', description: '子代理的最终文本结果' },
          childSessionId: { type: 'string', description: 'Agent Teams 成员的原生 DSH 会话标识' },
          providerSessionId: { type: 'string', description: '外部 Agent 的原生会话标识，可用于后续续聊' },
          toolCalls: { type: 'number', description: '子代理执行的工具次数' },
          usageSummary: { type: 'string', description: 'token 用量摘要' },
          background: { type: 'boolean', description: 'true 表示后台已启动；真实结果稍后写入子代理对话记录' },
        },
        required: ['agent', 'ok', 'result', 'childSessionId'],
        additionalProperties: false,
      },
      render: (_args: unknown, result: unknown) => [{
        type: 'text',
        text: typeof result === 'object' && result !== null && typeof (result as Record<string, any>).result === 'string'
          ? String((result as Record<string, any>).result)
          : JSON.stringify(result),
      }],
    },
    timeoutMs: SUBAGENT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal; agent?: { id?: string; session?: unknown } }) {
      const agentId = typeof args.agent === 'string' ? args.agent.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (agentId === '' || prompt.trim() === '') throw new Error('agent 与 prompt 均不能为空')
      const cwd = resolveCwd(typeof args.cwd === 'string' ? args.cwd : '', exec)
      const modelId = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined
      const parentSessionId = resolveParentSessionId(exec)
      const background = args.run_in_background === true

      // 最优路径：DSH 原生 Subagent 运行时。子会话由官方入口创建（header 带
      // origin=subagent + parentSession），在原生子智能体视图中呈现；外部 CLI
      // 路由经已注册的 provider 绑定，对话由原生界面渲染。
      const nativeSubagents = getNativeSubagents()
      const parentAgent = resolveParentAgent(exec)
      if (nativeSubagents?.startContinuable !== undefined && parentAgent !== undefined) {
        return runNativeContinuableSubagent(nativeSubagents, options.nativeSessions, {
          adapterId: agentId, prompt,
          parentAgent,
          ...(modelId === undefined ? {} : { modelId }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          background,
        })
      }

      // Agent Teams 路径：作为团队成员派发（同步等待首轮结果）。
      if (!background && options.nativeTeam?.diagnostic().supported === true && options.nativeSessions?.supportsEvents === true && options.nativeSessions.store !== undefined && parentSessionId !== undefined) {
        const parent = options.nativeSessions.get(parentSessionId) as { header?: { cwd?: string } } | undefined
        const parentCwd = parent?.header?.cwd
        if (typeof args.cwd === 'string' && args.cwd.trim() !== '' && (parentCwd === undefined || cwd === undefined || resolve(cwd) !== resolve(parentCwd))) {
          throw new Error('Agent Teams 子代理必须使用主会话工作目录；请先切换主会话工作区')
        }
        return runNativeTeamSubagent(options.nativeTeam, options.nativeSessions, {
          adapterId: agentId, prompt, parentSessionId,
          ...(modelId === undefined ? {} : { modelId }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
      }

      const conversations = getSubagentConversations()
      if (conversations === undefined) throw new Error('外部子代理会话服务尚未就绪')
      return conversations.run({
        adapterId: agentId,
        prompt,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(modelId === undefined ? {} : { modelId }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      }, { background })
    },
  }
}

interface NativeContinuableRequest {
  readonly adapterId: string
  readonly prompt: string
  readonly parentAgent: unknown
  readonly modelId?: string
  readonly signal?: AbortSignal
  readonly background: boolean
}

/** 经 DSH 官方 startContinuable 创建原生子会话并等待首轮结果。 */
async function runNativeContinuableSubagent(
  subagents: NativeSubagentService,
  sessions: CodingNsNativeSessionBridge | undefined,
  request: NativeContinuableRequest,
): Promise<Record<string, unknown>> {
  const started = await withTeamSubagentSelection(
    parentAgentId(request.parentAgent),
    request.adapterId,
    request.modelId,
    async () => subagents.startContinuable!({
      provider: externalTeamProvider(request.adapterId),
      label: request.prompt.replace(/\s+/gu, ' ').trim().slice(0, 120),
      request: {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: request.parentAgent,
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }),
  )
  const childSessionId = started.childId
  if (request.background) {
    return {
      childSessionId,
      agent: request.adapterId,
      ok: true,
      background: true,
      result: `子代理已在原生子智能体会话中启动（${request.adapterId}）。进度与结果见该会话；可提醒用户在会话列表的子智能体视图中查看。`,
      toolCalls: 0,
    }
  }
  // 同步等待子 Agent 首轮结束：订阅原生事件流，收 childSessionId 的 turn/end。
  const firstResult = await waitForChildFirstTurn(sessions, childSessionId, request.signal)
  return {
    childSessionId,
    agent: request.adapterId,
    ok: firstResult.ok,
    result: firstResult.text !== '' ? firstResult.text : '(子代理没有文本输出)',
    providerSessionId: childSessionId,
    toolCalls: firstResult.toolCalls,
    ...(firstResult.usageSummary !== undefined ? { usageSummary: firstResult.usageSummary } : {}),
  }
}

function parentAgentId(parentAgent: unknown): string {
  const id = (parentAgent as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : 'unknown-parent'
}

function resolveParentAgent(exec: { agent?: unknown }): unknown {
  const agent = exec.agent as { session?: { header?: { id?: unknown } } } | undefined
  const sessionId = agent?.session?.header?.id
  return typeof sessionId === 'string' && sessionId !== '' ? agent : undefined
}

interface ChildFirstTurn {
  readonly ok: boolean
  readonly text: string
  readonly toolCalls: number
  readonly usageSummary?: string
}

/** 订阅原生事件流直到子会话首个 turn/end；超时按 DSH 空闲处理。 */
function waitForChildFirstTurn(sessions: CodingNsNativeSessionBridge | undefined, childSessionId: string, signal: AbortSignal | undefined): Promise<ChildFirstTurn> {
  return new Promise((resolve) => {
    const state: { text: string; toolCalls: number; usage?: string; done: boolean } = { text: '', toolCalls: 0, done: false }
    let detach: (() => void) | undefined
    const finish = (): void => {
      if (state.done) return
      state.done = true
      detach?.()
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(giveUpTimer)
      resolve({
        ok: !signal?.aborted,
        text: state.text,
        toolCalls: state.toolCalls,
        ...(state.usage !== undefined ? { usageSummary: state.usage } : {}),
      })
    }
    const onAbort = (): void => finish()
    signal?.addEventListener('abort', onAbort, { once: true })
    // 兜底：外部 CLI 卡死时最长等 15 分钟（与工具超时一致）。
    const giveUpTimer = setTimeout(finish, 15 * 60_000)
    giveUpTimer.unref?.()
    if (sessions?.subscribe === undefined) { finish(); return }
    detach = sessions.subscribe({
      onEvent(session, event) {
        const header = (session as { header?: { id?: unknown } } | undefined)?.header
        if (header?.id !== childSessionId) return
        const row = event as { type?: unknown } | null
        if (row === null || typeof row.type !== 'string') return
        if (row.type === 'assistant/message') {
          const message = (event as { message?: { content?: readonly { type?: string; text?: unknown }[] } }).message
          for (const block of message?.content ?? []) {
            if (block?.type === 'text' && typeof block.text === 'string') state.text = block.text
          }
        } else if (row.type === 'tool/result') {
          state.toolCalls += 1
        } else if (row.type === 'turn/end') {
          setTimeout(finish, 300)
        }
      },
    }) as (() => void) | undefined
  })
}

interface NativeTeamRunRequest {
  readonly adapterId: string
  readonly prompt: string
  readonly parentSessionId: string
  readonly modelId?: string
  readonly signal?: AbortSignal
}

async function runNativeTeamSubagent(
  team: CodingNsNativeTeamProxy,
  sessions: CodingNsNativeSessionBridge,
  request: NativeTeamRunRequest,
): Promise<Record<string, unknown>> {
  const observed = new Map<string, { finished: boolean; reason?: string; message?: string; toolCalls: number }>()
  let targetId: string | undefined
  let onFinish: (() => void) | undefined
  const dispose = sessions.subscribe({ onEvent(session, event) {
    const header = recordValue(recordValue(session)?.header)
    if (header?.parentSession !== request.parentSessionId) return
    const id = typeof header.id === 'string' ? header.id : undefined
    const row = recordValue(event)
    if (id === undefined || row === null) return
    const current = observed.get(id) ?? { finished: false, toolCalls: 0 }
    if (row.type === 'assistant/message') {
      const text = messageText(recordValue(row.data)?.message)
      if (text !== '') current.message = text
    } else if (row.type === 'tool/result') {
      current.toolCalls += 1
    } else if (row.type === 'turn/end') {
      current.finished = true
      const reason = recordValue(recordValue(row.data)?.reason)?.kind
      if (typeof reason === 'string') current.reason = reason
    }
    observed.set(id, current)
    if (targetId === id && current.finished) onFinish?.()
  } })
  try {
    const signal = request.signal ?? new AbortController().signal
    const raw = await withTeamSubagentSelection(request.parentSessionId, request.adapterId, request.modelId, async () => team.invoke('spawn', {
      sessionId: request.parentSessionId,
      name: `${request.adapterId}-${randomUUID()}`,
      description: request.prompt.replace(/\s+/gu, ' ').trim().slice(0, 180),
      prompt: [{ type: 'text', text: request.prompt }],
      context: 'fresh',
      provider: externalTeamProvider(request.adapterId),
    }, signal))
    const member = recordValue(recordValue(raw)?.member)
    const childSessionId = member?.id
    if (typeof childSessionId !== 'string' || childSessionId === '') throw new Error('Agent Teams 没有返回子代理会话标识')
    targetId = childSessionId
    if (observed.get(childSessionId)?.finished !== true) {
      await new Promise<void>((resolveWait, rejectWait) => {
        const settle = (error?: Error): void => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abort)
          onFinish = undefined
          if (error === undefined) resolveWait()
          else rejectWait(error)
        }
        const abort = (): void => settle(new Error('子代理等待已中断，可在 Agent Teams 中继续查看'))
        const timeout = setTimeout(() => settle(new Error('子代理首轮运行超时，可在 Agent Teams 中继续查看')), SUBAGENT_TIMEOUT_MS - 10_000)
        timeout.unref?.()
        onFinish = () => settle()
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else if (observed.get(childSessionId)?.finished === true) onFinish?.()
      })
    }
    const resultAtCompletion = observed.get(childSessionId)
    const events = snapshotEvents(sessions.get(childSessionId))
    const lastEnd = [...events].reverse().find((event) => recordValue(event)?.type === 'turn/end')
    const reason = recordValue(recordValue(lastEnd)?.data)?.reason
    const completed = (resultAtCompletion?.reason ?? recordValue(reason)?.kind) === 'completed'
    const lastMessage = [...events].reverse().find((event) => {
      const row = recordValue(event)
      return row?.type === 'assistant/message' && messageText(recordValue(row.data)?.message) !== ''
    })
    const result = resultAtCompletion?.message || messageText(recordValue(recordValue(lastMessage)?.data)?.message) || '(子代理没有文本输出)'
    const providerSessionId = getAdapterRegistry()?.getSession(childSessionId).providerSessionId
    return {
      childSessionId,
      agent: request.adapterId,
      ok: completed,
      result,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      toolCalls: resultAtCompletion?.toolCalls ?? events.filter((event) => recordValue(event)?.type === 'tool/result').length,
    }
  } finally { dispose() }
}

function recordValue(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null
}

function snapshotEvents(session: unknown): readonly unknown[] {
  const snapshot = recordValue(session)?.snapshotEvents
  if (typeof snapshot !== 'function') return []
  try { const value: unknown = snapshot.call(session); return Array.isArray(value) ? value : [] }
  catch { return [] }
}

function messageText(value: unknown): string {
  const content = recordValue(value)?.content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => {
    const row = recordValue(block)
    return row?.type === 'text' && typeof row.text === 'string' ? row.text : ''
  }).filter(Boolean).join('\n').trim()
}

function resolveParentSessionId(exec: { agent?: { id?: string; session?: unknown } }): string | undefined {
  const agent = exec.agent
  const session = agent?.session
  if (typeof session === 'object' && session !== null) {
    const record = session as Record<string, any>
    for (const candidate of [record.id, record.header?.id, record.sessionId]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
  }
  return typeof agent?.id === 'string' && agent.id.trim() !== '' ? agent.id.trim() : undefined
}

function resolveCwd(value: string, exec: { agent?: { session?: unknown } }): string | undefined {
  const explicit = value.trim()
  if (explicit !== '') {
    try {
      return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
    } catch {
      return explicit
    }
  }
  const session = exec.agent?.session
  if (typeof session === 'object' && session !== null) {
    const record = session as Record<string, any>
    const workspace = record.workspace
    for (const candidate of [workspace?.workspacePath, workspace?.root, record.cwd]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return undefined
}
