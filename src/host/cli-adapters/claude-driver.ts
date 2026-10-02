import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliModelCatalog, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { discoverClaudeModelCatalog, parseEffortLevels } from './claude-model-options.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, serializeToolValue } from './tool-observation.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'

export class ClaudeCodeDriver extends StandardStreamDriver {
  private readonly sessionRoots: readonly string[]
  private readonly claudeConfigDir: string | undefined
  private readonly discoveryFetch: typeof fetch | undefined
  /** `claude --help` 声明的会话级思考档位；undefined 表示该 CLI 版本不接受 --effort。 */
  private effortLevels: readonly string[] | undefined
  private effortProbed = false

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] }, { binaries: ['claude'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')]
    this.claudeConfigDir = options.claudeConfigDir
    this.discoveryFetch = options.fetch
  }
  override async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await super.detect()
    if (result.command !== null) this.probeEffortLevels(result.command)
    return result
  }
  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detected = await this.detect()
    if (!detected.installed || detected.command === null) return emptyCatalog()
    try {
      return this.applyEffortLevels(await discoverClaudeModelCatalog({
        command: detected.command,
        spawn: this.runSpawn,
        ...(this.discoveryFetch ? { fetch: this.discoveryFetch } : {}),
        ...(this.claudeConfigDir ? { configDir: this.claudeConfigDir } : {}),
      }))
    } catch {
      return this.applyEffortLevels(CLAUDE_CATALOG)
    }
  }
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path) === `${id}.jsonl`,
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }
  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', promptWithAttachmentPaths(input.prompt, input.attachments ?? []), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    for (const directory of new Set((input.attachments ?? []).map((attachment) => dirname(attachment.path)))) args.push('--add-dir', directory)
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    // 只下发 CLI 自己在 --help 里声明过的档位：旧版本不认识 --effort，传了会直接失败。
    const effortId = input.effortId?.trim()
    if (effortId !== undefined && effortId !== '' && this.effortLevels?.includes(effortId) === true) args.push('--effort', effortId)
    return args
  }

  override dispose(): void {
    super.dispose()
    this.effortLevels = undefined
    this.effortProbed = false
  }

  /** 探测一次 `claude --help`，结果随驱动缓存；失败时保持"不支持"，不下发参数。 */
  private probeEffortLevels(command: string): void {
    if (this.effortProbed) return
    this.effortProbed = true
    try {
      const result = this.runSpawnSync(command, ['--help'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: process.platform === 'win32' })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      this.effortLevels = parseEffortLevels(output)
    } catch {
      this.effortLevels = undefined
    }
  }

  /**
   * 思考档位必须与下发能力一致：CLI 不认识 `--effort` 时清空档位（界面不展示做不到的东西），
   * 认识时给没有逐模型信息的模型补上命令行声明的会话级档位。
   */
  private applyEffortLevels(catalog: CodingNsCliModelCatalog): CodingNsCliModelCatalog {
    const levels = this.effortLevels
    const fallback = levels ?? []
    return {
      ...catalog,
      groups: catalog.groups.map((group) => ({
        ...group,
        models: group.models.map((model) => ({
          ...model,
          efforts: model.efforts.length > 0 && levels !== undefined ? model.efforts : fallback,
        })),
      })),
    }
  }
  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const event = value.type === 'stream_event' && typeof value.event === 'object' && value.event !== null ? value.event as Record<string, unknown> : value
    const delta = typeof event.delta === 'object' && event.delta !== null ? event.delta as Record<string, unknown> : null
    if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text-delta', text: delta.text }]
    if (event.type === 'content_block_start' && isToolRecord(event.content_block) && event.content_block.type === 'tool_use') {
      const tool = claudeToolUse(event.content_block)
      return tool === null ? [] : [tool]
    }
    if ((value.type === 'assistant' || value.type === 'user') && typeof value.message === 'object' && value.message !== null) {
      const message = value.message as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      return content.flatMap((part): CodingNsAgentEvent[] => {
        if (!part || typeof part !== 'object') return []
        const item = part as Record<string, unknown>
        if (item.type === 'tool_use') {
          const tool = claudeToolUse(item)
          return tool === null ? [] : [tool]
        }
        if (item.type === 'tool_result') {
          const tool = claudeToolResult(item)
          return tool === null ? [] : [tool]
        }
        return typeof item.text === 'string' ? [{ type: 'text-delta', text: item.text }] : []
      })
    }
    return super.parseEvent(value, input)
  }
}

function claudeToolUse(item: Record<string, unknown>): CodingNsAgentEvent | null {
  const toolName = firstToolText(item.name, item.toolName)
  if (toolName === undefined) return null
  const callId = firstToolText(item.id, item.tool_use_id, item.toolUseId)
  const input = serializeToolValue(item.input ?? item.arguments)
  const agentId = firstToolText(item.agentId, item.agent_id)
  const detail = serializeToolValue(item.detail)
  return {
    type: 'tool-event',
    toolName,
    status: 'running',
    ...(callId ? { callId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

function claudeToolResult(item: Record<string, unknown>): CodingNsAgentEvent | null {
  const callId = firstToolText(item.tool_use_id, item.toolUseId, item.callId)
  if (callId === undefined) return null
  const failed = item.is_error === true || item.isError === true
  const content = serializeToolValue(item.content ?? item.output ?? item.result)
  const agentId = firstToolText(item.agentId, item.agent_id)
  const detail = serializeToolValue(item.detail)
  return {
    type: 'tool-event',
    toolName: firstToolText(item.name, item.toolName) ?? 'tool',
    callId,
    status: failed ? 'failed' : 'completed',
    ...(failed ? (content === undefined ? {} : { error: content }) : (content === undefined ? {} : { output: content })),
    ...(!failed && content !== undefined ? { outputMode: 'snapshot' as const } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

/** 简短别名，便于按适配器名称装配。 */
export { ClaudeCodeDriver as ClaudeDriver }
