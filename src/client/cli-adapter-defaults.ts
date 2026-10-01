import type { CodingNsSettings } from '../shared/contracts/config.js'
import type { CodingNsCliModelCatalog } from '../shared/contracts/cli-adapter.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc, findModel } from './cli-catalog.js'

export interface CliAdapterDefaultsDraft {
  readonly modelId: string
  readonly effortId: string
  readonly customModelText: string
}

/** 自定义目录只接受逐行完整 ID，保留大小写和提供商前缀。 */
export function parseCustomModelIds(text: string): string[] {
  return [...new Set(text.split(/\r?\n/u).map((id) => id.trim()).filter(Boolean))]
}

export function mergeCustomModelCatalog(catalog: CodingNsCliModelCatalog | null, customModelIds: readonly string[], name: string): CodingNsCliModelCatalog {
  const base = catalog ?? { groups: [], currentModel: null, currentEffort: null }
  // Host 的持久目录由本地草稿替换，删除条目后不再显示旧值。
  const scannedGroups = base.groups.filter((group) => group.id !== 'codingns-custom')
  const seen = new Set(scannedGroups.flatMap((group) => group.models.map((model) => model.id)))
  const models = [...new Set(customModelIds)].filter((id) => !seen.has(id)).map((id) => ({ id, name: id, efforts: [] }))
  return { ...base, groups: [...scannedGroups, ...(models.length === 0 ? [] : [{ id: 'codingns-user-models', name, models }])] }
}

/** 未扫描到的模型不推测思考强度；扫描失败时保留手动模型。 */
export function compatibleEffort(catalog: CodingNsCliModelCatalog | null, modelId: string, effortId: string): string {
  return catalog !== null && findModel(catalog, modelId.trim())?.efforts.includes(effortId) ? effortId : ''
}

export async function scanCliAdapterModels(rpc: CodingNsRpcClient, adapterId: string, refresh: boolean): Promise<CodingNsCliModelCatalog> {
  return callCliRpc<CodingNsCliModelCatalog>(rpc, 'models', { adapterId, ...(refresh ? { refresh: true } : {}) })
}

export async function saveCliAdapterDefaults(settings: CodingNsSettingsStore<CodingNsSettings>, adapterId: string, draft: CliAdapterDefaultsDraft, catalog: CodingNsCliModelCatalog | null): Promise<boolean> {
  const modelId = draft.modelId.trim()
  const effortId = compatibleEffort(catalog, modelId, draft.effortId)
  const value = {
    ...(modelId ? { modelId } : {}),
    ...(effortId ? { effortId } : {}),
    customModelIds: parseCustomModelIds(draft.customModelText),
  }
  return settings.mutate([{ op: 'set', path: ['agentAdapterDefaults', adapterId], value }])
}

/** 清除固定默认不会删除用户的模型目录。 */
export async function clearCliAdapterDefaults(settings: CodingNsSettingsStore<CodingNsSettings>, adapterId: string): Promise<boolean> {
  return settings.mutate([
    { op: 'unset', path: ['agentAdapterDefaults', adapterId, 'modelId'] },
    { op: 'unset', path: ['agentAdapterDefaults', adapterId, 'effortId'] },
  ])
}
