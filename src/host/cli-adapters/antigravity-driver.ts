import { dirname } from 'node:path'
import type {
  CodingNsAgentEvent,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import { StandardStreamDriver, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { ANTIGRAVITY_CATALOG } from './model-catalog.js'
import { usageChunk } from './rpc-driver-utils.js'
import { firstToolText, serializeToolValue } from './tool-observation.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'

/**
 * Google Antigravity CLI（`agy`）适配器。
 *
 * 已实测（agy 1.2.1，2026-10-01）：
 * - `agy --version` 输出版本号，可用于安装探测。
 * - `agy models` 按 `id<TAB>名称` 输出当前账号可用的模型；思考强度包含在模型 ID 里
 *   （例如 `gemini-3.8-flash-high`），因此驱动不接受单独的 `--effort`。
 * - print 模式下 `--input-format stream-json` 从 stdin 读取 NDJSON，
 *   信封为 `{"event":"user","message":{"content":[{"type":"text","text":"…"}]}}`。
 * - 输出事件为 `init` / `step_update` / `result`；`init.conversation_id` 可用于
 *   `--conversation <id>` 恢复会话，`step_update.tool_info` 带工具名、参数与错误。
 *
 * 明确不声明：`permission`（headless 不接受双向审批，需要审批的工具会被自动拒绝）、
 * `questions`（print 模式硬编码跳过 ask_question）、`reasoning`（流里没有思考增量）、
 * `steer` / `continuable` / `team-proxy`（print 模式没有对应通道）。
 */
export class AntigravityDriver extends StandardStreamDriver {
  constructor(options: StandardStreamDriverOptions = {}) {
    super({
      id: 'antigravity',
      name: 'Antigravity',
      protocol: 'stream-json',
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'usage'],
    }, { binaries: ['agy'], versionArgs: ['--version'], modelArgs: ['models'] }, options)
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    // prompt 只走 stdin，不进命令行：Windows 经 cmd.exe 启动时参数不做转义。
    // agy 唯一的权限开关是 --dangerously-skip-permissions，与其它适配器的全放行惯例一致；
    // DSH 侧不提供审批通道，README 已如实标注。
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions']
    for (const directory of new Set((input.attachments ?? []).map((attachment) => dirname(attachment.path)))) args.push('--add-dir', directory)
    if (input.providerSessionId?.trim()) args.push('--conversation', input.providerSessionId.trim())
    if (input.modelId?.trim()) args.push('--model', input.modelId.trim())
    return args
  }

  protected stdinPrompt(input: CodingNsCliTurnInput): string {
    return JSON.stringify({
      event: 'user',
      message: { content: [{ type: 'text', text: promptWithAttachmentPaths(input.prompt, input.attachments ?? []) }] },
    })
  }

  /** `agy models` 输出 `id<TAB>显示名`；进度与错误在 stderr，因此只认带制表符的行。 */
  protected parseModels(output: string): CodingNsCliModelCatalog {
    const models: CodingNsCliModel[] = []
    const seen = new Set<string>()
    for (const line of output.split(/\r?\n/u)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)\t+(\S.*)$/u.exec(line.trim())
      if (match === null) continue
      const id = match[1]!
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ id, name: match[2]!.trim(), efforts: [] })
    }
    // 目录为空时返回静态候选：Host 会据此提示"内置候选"，而不是假装扫描成功。
    if (models.length === 0) return ANTIGRAVITY_CATALOG
    return { groups: [{ id: 'antigravity', name: 'Antigravity', models }], currentModel: null, currentEffort: null }
  }

  /** 未登录、离线或扫描失败时基座返回空目录；已安装的 CLI 回退到内置候选。 */
  async listModels(): Promise<CodingNsCliModelCatalog> {
    const catalog = await super.listModels()
    if (catalog.groups.some((group) => group.models.length > 0)) return catalog
    return (await this.detect()).command === null ? catalog : ANTIGRAVITY_CATALOG
  }

  /**
   * `step_update` 的收尾步骤与 `result` 会重复上报同一份 usage。
   * 同一轮内只保留第一次，避免投影层记录两条完全相同的采样。
   */
  override async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    let lastUsage = ''
    for await (const chunk of super.executeTurn(input)) {
      if (chunk.type === 'usage') {
        const signature = `${chunk.inputTokens}/${chunk.outputTokens}/${chunk.cacheReadTokens ?? 0}/${chunk.cacheWriteTokens ?? 0}/${chunk.totalTokens ?? 0}`
        if (signature === lastUsage) continue
        lastUsage = signature
      }
      yield chunk
    }
  }

  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const kind = typeof value.event === 'string' ? value.event : ''
    if (kind === 'init') return []
    if (kind === 'step_update') return stepChunks(asRecord(value.step_update))
    if (kind === 'result') return resultChunks(asRecord(value.result), input)
    // 事件表是封闭集合；未知事件按无副作用处理，不交给通用解析器猜字段。
    return []
  }
}

function stepChunks(step: Record<string, unknown> | null): readonly CodingNsAgentEvent[] {
  if (step === null) return []
  const chunks: CodingNsAgentEvent[] = []
  // text_delta 是增量正文；result.response 是同一段正文的汇总，不能重复输出。
  const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
  if (delta !== '') chunks.push({ type: 'text-delta', text: delta })
  const usage = usageChunk(step.usage)
  if (usage !== null) chunks.push(usage)
  if (typeof step.step_type === 'string' && step.step_type.toLowerCase() === 'tool') chunks.push(...toolChunks(step))
  return chunks
}

/** 工具状态用同一个 step_index 派生的 callId 关联 running → completed/failed。 */
function toolChunks(step: Record<string, unknown>): readonly CodingNsAgentEvent[] {
  const info = asRecord(step.tool_info) ?? {}
  const toolName = firstToolText(step.tool_name, info.name, info.toolName) ?? 'tool'
  const state = typeof step.state === 'string' ? step.state.trim().toLowerCase() : ''
  const failure = info.error
  const failed = state === 'error' || state === 'failed' || failure !== undefined
  const completed = state === 'done' || state === 'complete' || state === 'completed'
  const status = failed ? 'failed' as const : completed ? 'completed' as const : 'running' as const
  const inputValue = serializeToolValue(info.parameters ?? info.input ?? info.arguments)
  const outputValue = serializeToolValue(info.output ?? info.result)
  const errorValue = serializeToolValue(asRecord(failure) === null ? failure : asRecord(failure)!.message ?? failure)
  const stepIndex = typeof step.step_index === 'number' && Number.isFinite(step.step_index) ? step.step_index : undefined
  const callId = firstToolText(info.call_id, info.callId, stepIndex === undefined ? undefined : `antigravity-step-${stepIndex}`)
  return [{
    type: 'tool-event',
    toolName,
    status,
    ...(callId === undefined ? {} : { callId }),
    ...(inputValue === undefined ? {} : { input: inputValue }),
    ...(outputValue === undefined || status === 'running' ? {} : { output: outputValue, outputMode: 'snapshot' as const }),
    ...(errorValue === undefined ? {} : { error: errorValue }),
  }]
}

function resultChunks(result: Record<string, unknown> | null, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
  if (result === null) return []
  const chunks: CodingNsAgentEvent[] = []
  const usage = usageChunk(result.usage)
  if (usage !== null) chunks.push(usage)
  if (input.signal?.aborted) {
    chunks.push({ type: 'finish', reason: 'cancel' })
    return chunks
  }
  if (typeof result.status === 'string' && result.status.trim().toUpperCase() === 'ERROR') {
    // 抛错让投影层把原始原因写进 finish(error)，而不是变成通用的"执行失败"。
    throw new Error(`Antigravity: ${firstToolText(result.error) ?? '执行失败'}`)
  }
  const response = typeof result.response === 'string' ? result.response.trim() : ''
  const denied = deniedActions(result)
  if (response === '' && denied.length > 0) {
    // headless 无法应答审批：把被拒绝的工具名直接告诉用户，避免显示成空回合。
    throw new Error(`Antigravity 的工具调用被自动拒绝（${denied.join('、')}）；请在 Antigravity settings.json 的 permissions.allow 中放行，或改用交互式会话。`)
  }
  chunks.push({ type: 'finish', reason: 'stop' })
  return chunks
}

function deniedActions(result: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(result.denied_actions)) return []
  return [...new Set(result.denied_actions
    .map((item) => firstToolText(asRecord(item)?.display_name, asRecord(item)?.action))
    .filter((name): name is string => name !== undefined))]
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null
}
