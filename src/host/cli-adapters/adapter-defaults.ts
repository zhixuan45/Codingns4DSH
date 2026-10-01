import { CODINGNS_CUSTOM_MODEL_GROUP_ID, CODINGNS_EXTERNAL_ADAPTER_IDS, type CodingNsCliModelCatalog, type CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import { CLAUDE_CATALOG, CODEX_CATALOG, GEMINI_CATALOG, GROK_CATALOG, KIMI_CATALOG, PI_CATALOG } from './model-catalog.js'
import type { CodingNsCliAdapterDefaults, CodingNsCliAdapterPreference } from '../../shared/contracts/config.js'

const MAX_ID_LENGTH = 512
const MAX_CUSTOM_MODELS = 200
const EFFORT_UNAVAILABLE = new Set(['claude-code', 'kimi', 'grok'])
const BUILTIN_CATALOGS = new Set([CLAUDE_CATALOG, CODEX_CATALOG, GEMINI_CATALOG, GROK_CATALOG, KIMI_CATALOG, PI_CATALOG])
const DIRECTORY_NOTICES: Readonly<Record<string, string>> = {
  'claude-code': '目录合并 CLI、本机配置及内置候选，尚未逐一验证模型可用性。',
  kimi: '目录来自 CLI 帮助中的模型候选，非完整模型枚举；可手动添加模型。',
}

export function isExternalAdapterId(value: string): boolean {
  return (CODINGNS_EXTERNAL_ADAPTER_IDS as readonly string[]).includes(value)
}

/** 模型切换时不继承另一模型的思考档位。 */
export function resolveAdapterSelection(
  config: CodingNsCliSessionConfig,
  previous: CodingNsCliSessionConfig | undefined,
  defaults: CodingNsCliAdapterDefaults | undefined,
  remembered: CodingNsCliAdapterPreference | undefined,
): Pick<CodingNsCliSessionConfig, 'modelId' | 'effortId'> {
  const existing = previous?.adapterId === config.adapterId ? previous : undefined
  const modelId = config.modelId?.trim() || existing?.modelId || defaults?.modelId || remembered?.modelId
  const effortId = config.effortId?.trim()
    || (existing?.modelId === modelId ? existing?.effortId : undefined)
    || (defaults?.modelId === undefined || defaults.modelId === modelId ? defaults?.effortId : undefined)
    || (remembered?.modelId === modelId ? remembered?.effortId : undefined)
  return { ...(modelId ? { modelId } : {}), ...(effortId ? { effortId } : {}) }
}

/** RPC 只接受明确的字段；模型无需出现在扫描目录。 */
export function parseAdapterDefaults(value: unknown): CodingNsCliAdapterDefaults {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Agent 默认设置必须是对象')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['modelId', 'effortId', 'customModelIds'].includes(key))) throw new TypeError('Agent 默认设置包含未知字段')
  const readId = (input: unknown): string | undefined => {
    if (input === undefined) return undefined
    if (typeof input !== 'string' || input.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(input)) throw new TypeError('模型和思考强度必须是无控制字符的短字符串')
    return input.trim() || undefined
  }
  const modelId = readId(record.modelId)
  const effortId = readId(record.effortId)
  let customModelIds: string[] | undefined
  if (record.customModelIds !== undefined) {
    if (!Array.isArray(record.customModelIds) || record.customModelIds.length > MAX_CUSTOM_MODELS) throw new TypeError('自定义模型必须是最多 200 项的字符串数组')
    customModelIds = [...new Set(record.customModelIds.map((item) => {
      if (typeof item !== 'string') throw new TypeError('自定义模型必须是字符串')
      return readId(item)
    }).filter((id): id is string => id !== undefined))]
  }
  return {
    ...(modelId ? { modelId } : {}),
    ...(effortId ? { effortId } : {}),
    ...(customModelIds === undefined ? {} : { customModelIds }),
  }
}

/** 只合并展示目录，缓存仍保存 CLI 扫描结果。 */
export function mergeAdapterModels(
  adapterId: string,
  catalog: CodingNsCliModelCatalog,
  defaults: CodingNsCliAdapterDefaults | undefined,
  scanError?: unknown,
): CodingNsCliModelCatalog {
  // 静态回退不能被界面误报为已扫描成功。
  scanError ??= BUILTIN_CATALOGS.has(catalog) ? 'CLI 未返回可用模型目录，显示内置候选；可手动添加模型。' : undefined
  const seen = new Set(catalog.groups.flatMap((group) => group.models.map((model) => model.id)))
  const custom = [...new Set(defaults?.customModelIds ?? [])].filter((id) => !seen.has(id))
  const groups = EFFORT_UNAVAILABLE.has(adapterId)
    ? catalog.groups.map((group) => ({ ...group, models: group.models.map((model) => ({ ...model, efforts: [] })) }))
    : [...catalog.groups]
  if (custom.length > 0) groups.push({ id: CODINGNS_CUSTOM_MODEL_GROUP_ID, name: '自定义模型', models: custom.map((id) => ({ id, name: id, efforts: [] })) })
  return {
    ...catalog,
    groups,
    ...(catalog.scanNotice || DIRECTORY_NOTICES[adapterId] ? { scanNotice: catalog.scanNotice ?? DIRECTORY_NOTICES[adapterId] } : {}),
    ...(scanError === undefined ? {} : { scanError: scanError instanceof Error ? scanError.message.slice(0, 512) : String(scanError).slice(0, 512) }),
  }
}

export function mergePreferenceRecords(
  legacy: Readonly<Record<string, CodingNsCliAdapterPreference>>,
  configured: Readonly<Record<string, CodingNsCliAdapterPreference>> | undefined,
): Readonly<Record<string, CodingNsCliAdapterPreference>> {
  const merged: Record<string, CodingNsCliAdapterPreference> = {}
  for (const [adapterId, preference] of Object.entries(legacy)) {
    const normalized = normalizePreference(preference)
    if (normalized !== undefined) merged[adapterId] = normalized
  }
  for (const [adapterId, preference] of Object.entries(configured ?? {})) {
    const normalized = normalizePreference(preference)
    if (normalized === undefined) continue
    merged[adapterId] = { ...merged[adapterId], ...normalized }
  }
  return merged
}

function normalizePreference(value: CodingNsCliAdapterPreference | undefined): CodingNsCliAdapterPreference | undefined {
  if (value === undefined) return undefined
  const modelId = value.modelId?.trim()
  const effortId = value.effortId?.trim()
  if (modelId === undefined && effortId === undefined) return undefined
  return { ...(modelId ? { modelId } : {}), ...(effortId ? { effortId } : {}) }
}

export function hasMissingPreferences(
  configured: Readonly<Record<string, CodingNsCliAdapterPreference>> | undefined,
  legacy: Readonly<Record<string, CodingNsCliAdapterPreference>>,
): boolean {
  return Object.entries(legacy).some(([id, preference]) => {
    const current = configured?.[id]
    return preference.modelId !== undefined && !current?.modelId?.trim()
      || preference.effortId !== undefined && !current?.effortId?.trim()
  })
}

export function preferenceSnapshot(preferences: ReadonlyMap<string, CodingNsCliAdapterPreference>): Record<string, CodingNsCliAdapterPreference> {
  return Object.fromEntries([...preferences.entries()].map(([adapterId, preference]) => [adapterId, { ...preference }]))
}
