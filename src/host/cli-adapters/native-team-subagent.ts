import { getAdapterRegistry } from './registry-holder.js'

/** Stable DSH Subagent provider names. A continuable Team child owns a real DSH Agent. */
export const EXTERNAL_SUBAGENT_IDS = [
  'claude-code', 'codex', 'kimi', 'gemini', 'pi', 'opencode', 'grok', 'command-code', 'antigravity',
] as const

export type ExternalSubagentId = typeof EXTERNAL_SUBAGENT_IDS[number]

export function externalTeamProvider(adapterId: string): string {
  return `codingns-external-${adapterId}`
}

interface NativeParent {
  readonly id: string
}

interface PrepareRequest {
  readonly sessionId: string
  readonly parent: NativeParent
  readonly signal: AbortSignal
}

export interface NativeSubagentService {
  registerProvider(provider: {
    readonly name: string
    readonly capabilities: Record<string, boolean>
    readonly inheritsParentContext: boolean
    start(request: unknown): never
    prepareContinuable(request: PrepareRequest): Promise<Record<string, never>>
  }): unknown
  /** DSH 官方入口：创建带 origin=subagent 原生身份的子会话并投递 prompt。 */
  startContinuable?(spec: {
    readonly childId?: string
    readonly provider: string
    readonly label?: string
    readonly request: {
      readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
      readonly parent: unknown
      readonly maxDepth?: number
    }
    readonly signal?: AbortSignal
  }): Promise<{ readonly childId: string; readonly messageId: string }>
}

interface PendingSelection {
  readonly modelId?: string
}

const pendingSelections = new Map<string, PendingSelection>()

function selectionKey(parentId: string, adapterId: string): string {
  return `${parentId}\u0000${adapterId}`
}

/** The Agent tool is not concurrency safe, so one caller can reserve its next child route. */
export async function withTeamSubagentSelection<T>(
  parentId: string,
  adapterId: string,
  modelId: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const key = selectionKey(parentId, adapterId)
  if (pendingSelections.has(key)) throw new Error('同一 Agent 的子代理创建正在进行中')
  pendingSelections.set(key, modelId === undefined ? {} : { modelId })
  try { return await action() }
  finally { pendingSelections.delete(key) }
}

/** Register once in the DSH Subagent scope; Team owns roster and Session lifecycle. */
export function registerNativeTeamSubagentProviders(service: NativeSubagentService): void {
  for (const adapterId of EXTERNAL_SUBAGENT_IDS) {
    service.registerProvider({
      name: externalTeamProvider(adapterId),
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: true,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
      start() { throw new Error('外部 Agent Team 提供方只支持可续聊子代理') },
      async prepareContinuable(request) {
        request.signal.throwIfAborted()
        const registry = getAdapterRegistry()
        if (registry === undefined) throw new Error('外部 Agent 适配器尚未就绪')
        const adapter = (await registry.catalog()).find((item) => item.id === adapterId)
        if (adapter === undefined || !adapter.installed || !adapter.enabled) {
          throw new Error(`${adapterId} 未安装或未启用`)
        }
        request.signal.throwIfAborted()
        const selected = pendingSelections.get(selectionKey(request.parent.id, adapterId))
        registry.setSession(request.sessionId, {
          adapterId,
          parentSessionId: request.parent.id,
          origin: 'subagent',
          ...(selected?.modelId === undefined ? {} : { modelId: selected.modelId }),
        })
        await registry.flushSessionBindings()
        return {}
      },
    })
  }
}
