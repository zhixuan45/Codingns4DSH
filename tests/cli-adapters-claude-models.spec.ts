import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { parseEffortLevels } from '../data/build/dist/host/cli-adapters/claude-model-options.js'

/** 实测 2.1.268 的帮助文本片段：档位是会话级的，非法值只警告并回退默认。 */
const CLAUDE_HELP_WITH_EFFORT = [
  'Usage: claude [options] [command] [prompt]',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '',
].join('\n')

/** 构造只回答 --version / --help 的伪 CLI，用于断言参数与目录。 */
function effortDriver(options: { readonly help: string; readonly model?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-effort-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: options.model === undefined ? {} : { ANTHROPIC_MODEL: options.model } }), 'utf8')
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    claudeConfigDir: configDir,
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'claude 2.1.0', stderr: '' }
      : { status: 0, stdout: options.help, stderr: '' }) as never,
    spawn: (() => fakeClaudeProcess('', 1)) as never,
    fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
  })
  return { driver, root }
}

const buildArgs = (driver: ClaudeCodeDriver, input: Record<string, unknown>): string[] =>
  (driver as unknown as { buildArgs(input: Record<string, unknown>): string[] }).buildArgs(input)

function fakeClaudeProcess(output: string, code = 0): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: { end(value: string): void }
    kill(): boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = { end() {
    queueMicrotask(() => {
      if (output) child.stdout.write(output)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', code)
    })
  } }
  child.kill = () => true
  return child
}

test('Claude Code 通过 initialize、网关和 settings.json 合并真实模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-models-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    ANTHROPIC_AUTH_TOKEN: 'secret-token',
    ANTHROPIC_MODEL: 'deepseek/deepseek-chat',
  } }), 'utf8')
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportedEffortLevels: ['high'] },
    ] },
  } }) + '\n'
  const calls: string[] = []
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : args[0] === '--help'
          ? { status: 0, stdout: CLAUDE_HELP_WITH_EFFORT, stderr: '' }
          : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: ((command: string, args: string[]) => { calls.push(`${command} ${args.join(' ')}`); return fakeClaudeProcess(initialize) }) as never,
      fetch: (async (url: string, init?: RequestInit) => {
        assert.equal(url, 'https://gateway.example/v1/models')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-token')
        assert.equal(new Headers(init?.headers).get('x-api-key'), 'secret-token')
        return new Response(JSON.stringify({ data: [{ id: 'gateway-sonnet', display_name: 'Gateway Sonnet' }] }), { status: 200 })
      }) as typeof fetch,
    })
    const catalog = await driver.listModels()
    const models = catalog.groups[0]?.models ?? []
    assert.deepEqual(models.map((model) => model.id), ['provider-default', 'sonnet', 'opus', 'haiku', 'claude-opus-4-8', 'gateway-sonnet', 'deepseek/deepseek-chat'])
    assert.equal(models.find((model) => model.id === 'claude-opus-4-8')?.efforts.join(','), 'high')
    assert.doesNotMatch(JSON.stringify(catalog), /secret-token/u)
    assert.equal(calls.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 动态发现失败时回退静态别名并保留配置模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-models-fallback-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek/deepseek-reasoner', ANTHROPIC_BASE_URL: 'https://gateway.example' } }), 'utf8')
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess('', 1)) as never,
      fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
    })
    const ids = (await driver.listModels()).groups[0]?.models.map((model) => model.id) ?? []
    assert.deepEqual(ids, ['provider-default', 'sonnet', 'opus', 'haiku', 'deepseek/deepseek-reasoner'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 未安装时不伪造模型目录', async () => {
  const driver = new ClaudeCodeDriver({
    binaries: ['missing-claude'],
    spawnSync: (() => { throw new Error('missing') }) as never,
  })
  assert.deepEqual(await driver.listModels(), { groups: [], currentModel: null, currentEffort: null })
})

test('Claude Code 按 --help 声明下发 --effort，并给没有逐模型档位的模型补上会话级档位', async () => {
  const { driver, root } = effortDriver({ help: CLAUDE_HELP_WITH_EFFORT, model: 'claude-opus-5-5' })
  try {
    const models = (await driver.listModels()).groups[0]?.models ?? []
    // 账号里配置的模型可能不在 CLI 已知目录内（实测 claude-opus-5-5），档位只能来自命令行声明。
    assert.deepEqual(models.find((model) => model.id === 'claude-opus-5-5')?.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(models.find((model) => model.id === 'sonnet')?.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(buildArgs(driver, { sessionId: 's', messages: [], prompt: 'hi', effortId: 'xhigh' }).slice(-2), ['--effort', 'xhigh'])
    assert.equal(buildArgs(driver, { sessionId: 's', messages: [], prompt: 'hi' }).includes('--effort'), false)
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI 不认识 --effort 时既不下发参数也不展示档位', async () => {
  const { driver, root } = effortDriver({ help: 'Usage: claude [options]\n  --model <model>  Model for the session\n', model: 'claude-opus-5-5' })
  try {
    const models = (await driver.listModels()).groups[0]?.models ?? []
    assert.deepEqual(models.find((model) => model.id === 'claude-opus-5-5')?.efforts, [])
    // 静态别名在旧 CLI 上同样不能展示：展示了就一定会被静默忽略。
    assert.deepEqual(models.find((model) => model.id === 'sonnet')?.efforts, [])
    assert.equal(buildArgs(driver, { sessionId: 's', messages: [], prompt: 'hi', effortId: 'high' }).includes('--effort'), false)
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('只解析 --effort 附近的档位列表，缺少该参数时返回 undefined', () => {
  assert.deepEqual(parseEffortLevels(CLAUDE_HELP_WITH_EFFORT), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(parseEffortLevels('Usage: claude [options]\n  --model <model>\n'), undefined)
})

test('ANTHROPIC_BASE_URL 带 /v1/messages 时仍拼出正确的网关模型地址', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-gateway-url-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://faroapi.example/v1/messages',
    ANTHROPIC_AUTH_TOKEN: 'gateway-token',
  } }), 'utf8')
  const urls: string[] = []
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 2.1.0', stderr: '' }
        : { status: 0, stdout: CLAUDE_HELP_WITH_EFFORT, stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess('', 1)) as never,
      fetch: (async (url: string) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Gateway Opus' }] }), { status: 200 })
      }) as typeof fetch,
    })
    const ids = (await driver.listModels()).groups[0]?.models.map((model) => model.id) ?? []
    // 不能拼成 …/v1/messages/v1/models
    assert.deepEqual(urls, ['https://faroapi.example/v1/models'])
    assert.equal(ids.includes('claude-opus-5-5'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
