import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'

/**
 * 外部 CLI 没有稳定的模型目录接口时，使用随适配器验证过的最小目录。
 * 目录只保存模型 id 和 CLI 接受的思考档位，不包含凭据或远端响应。
 */
export function staticCatalog(
  groupId: string,
  groupName: string,
  models: readonly { id: string; name?: string; efforts: readonly string[] }[],
): CodingNsCliModelCatalog {
  return {
    groups: [{
      id: groupId,
      name: groupName,
      models: models.map((model) => ({ id: model.id, name: model.name ?? model.id, efforts: model.efforts })),
    }],
    currentModel: null,
    currentEffort: null,
  }
}

const GEMINI_EFFORTS_BY_MODEL = new Map<string, readonly string[]>([
  ['provider-default', ['low', 'medium', 'high']],
  ['auto', ['low', 'medium', 'high']],
  ['auto-gemini-3', ['low', 'medium', 'high']],
  ['auto-gemini-2.5', ['low', 'medium', 'high']],
  ['gemini-3.8-flash', ['low', 'medium', 'high']],
  ['gemini-3.7-flash', ['low', 'medium', 'high']],
  ['gemini-3.6-flash', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.5-flash', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.5-flash-lite', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.1-pro-preview', ['low', 'medium', 'high']],
  ['gemini-3.1-pro-preview-customtools', ['low', 'medium', 'high']],
  ['gemini-3.1-flash-lite-image', ['minimal', 'high']],
  ['gemini-3-flash-preview', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3-pro-preview', ['low', 'high']],
  ['gemini-2.5-pro', ['low', 'medium', 'high']],
  ['gemini-2.5-flash', ['low', 'medium', 'high']],
  ['gemini-2.5-flash-lite', ['low', 'medium', 'high']],
])

/** Gemini ACP 只返回模型标识；思考档位需按 Gemini 官方能力表补齐。 */
export function resolveGeminiEfforts(modelId: string): readonly string[] {
  return GEMINI_EFFORTS_BY_MODEL.get(modelId.trim().toLowerCase()) ?? []
}

export const CLAUDE_CATALOG = staticCatalog('claude', 'Claude', [
  { id: 'provider-default', name: '跟随 Claude 默认模型', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
])

export const KIMI_CATALOG = staticCatalog('kimi', 'Kimi', [
  { id: 'provider-default', name: '跟随 Kimi 默认模型', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k2.5', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k2-thinking', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'kimi-k3', efforts: ['low', 'high', 'max'] },
])

export const GEMINI_CATALOG = staticCatalog('gemini', 'Gemini', [
  { id: 'provider-default', name: '跟随 Gemini 默认模型', efforts: resolveGeminiEfforts('provider-default') },
  { id: 'auto-gemini-3', efforts: resolveGeminiEfforts('auto-gemini-3') },
  { id: 'auto-gemini-2.5', efforts: resolveGeminiEfforts('auto-gemini-2.5') },
  { id: 'gemini-3.1-pro-preview', efforts: resolveGeminiEfforts('gemini-3.1-pro-preview') },
  { id: 'gemini-3-flash-preview', efforts: resolveGeminiEfforts('gemini-3-flash-preview') },
  { id: 'gemini-2.5-pro', efforts: resolveGeminiEfforts('gemini-2.5-pro') },
  { id: 'gemini-2.5-flash', efforts: resolveGeminiEfforts('gemini-2.5-flash') },
  { id: 'gemini-2.5-flash-lite', efforts: resolveGeminiEfforts('gemini-2.5-flash-lite') },
])

export const CODEX_CATALOG = staticCatalog('codex', 'Codex', [
  { id: 'provider-default', name: '跟随 Codex 默认模型', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high', 'xhigh'] },
])

/**
 * Codex app-server 在 request/context 中会先沿用 1M 的通用默认值，
 * 但 gpt-5.6-sol 的真实 tokenUsage.contextWindow 是 258400。
 * 这个提示只用于首个 usage 到达前稳定 DSH 的分母；真实 usage 仍然优先。
 */
export function knownCodexContextWindow(modelId: string | undefined): number | undefined {
  return modelId?.trim().toLowerCase() === 'gpt-5.6-sol' ? 258400 : undefined
}

export const GROK_CATALOG = staticCatalog('grok', 'Grok', [
  { id: 'provider-default', name: '跟随 Grok 默认模型', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'grok-4.6', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'grok-4.5', efforts: ['low', 'medium', 'high'] },
])

export const PI_CATALOG = staticCatalog('pi', 'Pi', [
  { id: 'provider-default', name: '跟随 Pi 默认模型', efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
])

/**
 * Antigravity CLI 的静态回退目录，取自 `agy models`（1.2.1）。
 * 思考强度包含在模型 ID 中，因此不单独标注 effort。
 */
export const ANTIGRAVITY_CATALOG = staticCatalog('antigravity', 'Antigravity', [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', efforts: [] },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', efforts: [] },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', efforts: [] },
  { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)', efforts: [] },
  { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)', efforts: [] },
  { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)', efforts: [] },
  { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)', efforts: [] },
  { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)', efforts: [] },
  { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)', efforts: [] },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', efforts: [] },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', efforts: [] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', efforts: [] },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: [] },
])

/** 把 CLI 帮助解析到的模型补上已知档位，未知模型保持空数组。 */
export function enrichEfforts(catalog: CodingNsCliModelCatalog, known: CodingNsCliModelCatalog): CodingNsCliModelCatalog {
  const effortById = new Map(known.groups.flatMap((group) => group.models.map((model) => [model.id.toLowerCase(), model.efforts] as const)))
  return {
    ...catalog,
    groups: catalog.groups.map((group) => ({
      ...group,
      models: group.models.map((model) => ({ ...model, efforts: effortById.get(model.id.toLowerCase()) ?? model.efforts })),
    })),
  }
}

export function isProviderDefaultModel(modelId: string | undefined): boolean {
  return modelId === undefined || modelId === '' || modelId === 'provider-default'
}
