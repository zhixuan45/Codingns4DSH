import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'
import { ANTIGRAVITY_CATALOG } from '../data/build/dist/host/cli-adapters/model-catalog.js'

/** 复刻 agy 的 print 模式子进程：stdout 逐行 NDJSON，stdin 接收一条用户消息。 */
function fakeChild() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const state = { written: '', stdinEnded: false, killed: false }
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => { state.written += chunk })
  const originalEnd = stdin.end.bind(stdin)
  stdin.end = ((...args) => { state.stdinEnded = true; return originalEnd(...args) })
  return {
    stdout,
    stderr,
    stdin,
    state,
    kill() { state.killed = true; stdout.end(); stderr.end(); return true },
  }
}

function driverWith(lines, captured = {}) {
  return new AntigravityDriver({
    spawnSync: ((command, args) => {
      if (args[0] === '--version') return { status: 0, stdout: '1.2.1', stderr: '' }
      if (args[0] === 'models') return { status: 0, stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n', stderr: '' }
      return { status: 127, stdout: '', stderr: '' }
    }) as never,
    spawn: ((command, args, options) => {
      captured.command = command
      captured.args = [...args]
      captured.stdio = options?.stdio
      const child = fakeChild()
      captured.child = child
      setImmediate(() => {
        for (const line of typeof lines === 'function' ? lines(child) : lines) child.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
        if (!captured.keepOpen) child.stdout.end()
      })
      return child
    }) as never,
  })
}

const INIT = { event: 'init', conversation_id: 'conv-1', init: { cwd: '.', tools: [], permission_mode: 'request-review' } }
const RESULT_OK = { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'OK\n', usage: { input_tokens: 10, output_tokens: 4 } } }

async function collect(iterator) {
  const chunks = []
  for await (const chunk of iterator) chunks.push(chunk)
  return chunks
}

test('Antigravity 探测使用 agy --version', async () => {
  const driver = driverWith([])
  assert.deepEqual(await driver.detect(), { installed: true, version: '1.2.1', command: 'agy' })
  assert.deepEqual(driver.descriptor.capabilities, ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'usage'])
  // headless 没有审批通道，也是 print 模式硬编码跳过提问：这两项绝不能声明。
  assert.equal(driver.descriptor.capabilities.includes('permission'), false)
  assert.equal(driver.descriptor.capabilities.includes('questions'), false)
  assert.equal(driver.descriptor.capabilities.includes('reasoning'), false)
})

test('Antigravity 把 prompt 写进 stdin，不放进命令行参数', async () => {
  const captured = {}
  const driver = driverWith([INIT, { event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'OK' } }, RESULT_OK], captured)
  const chunks = await collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: '只回复 OK', modelId: 'gemini-3.8-flash-medium', providerSessionId: 'conv-0' }))

  assert.equal(captured.command, 'agy')
  assert.deepEqual(captured.args, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--conversation', 'conv-0', '--model', 'gemini-3.8-flash-medium'])
  assert.equal(captured.args.some((arg) => arg.includes('只回复 OK')), false, 'prompt 不能出现在命令行里')
  assert.equal(captured.stdio[0], 'pipe')
  assert.deepEqual(JSON.parse(captured.child.state.written.trim()), {
    event: 'user',
    message: { content: [{ type: 'text', text: '只回复 OK' }] },
  })
  assert.equal(captured.child.state.stdinEnded, true)
  // 已经带 providerSessionId 的回合不再重复绑定；正文与用量按事件顺序输出。
  assert.deepEqual(chunks, [
    { type: 'text-delta', text: 'OK' },
    { type: 'usage', inputTokens: 10, outputTokens: 4 },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Antigravity 首轮从 init 绑定 conversation_id 作为可恢复会话标识', async () => {
  const captured = {}
  const driver = driverWith([INIT, RESULT_OK], captured)
  const chunks = await collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: '首轮' }))
  assert.deepEqual(chunks[0], { type: 'session-binding', providerSessionId: 'conv-1' })
  assert.equal(captured.args.includes('--conversation'), false)
})

test('Antigravity 不把 result.response 再输出一遍，避免正文重复', async () => {
  const captured = {}
  const driver = driverWith([
    INIT,
    { event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'OK' } },
    { event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 10, output_tokens: 4 } } },
    RESULT_OK,
  ], captured)
  const chunks = await collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x' }))
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta'), [
    { type: 'text-delta', text: 'OK' },
    { type: 'text-delta', text: '\n' },
  ])
  // step_update 收尾与 result 上报同一份 usage：只保留一次采样。
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1)
})

test('Antigravity 工具步骤映射为 running → completed 的同一 callId', async () => {
  const captured = {}
  const driver = driverWith([
    INIT,
    { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'Get-ChildItem -Name' } } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'Get-ChildItem -Name' }, output: 'alpha.txt' } } },
    RESULT_OK,
  ], captured)
  const chunks = await collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x' }))
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-event'), [
    { type: 'tool-event', toolName: 'run_command', status: 'running', callId: 'antigravity-step-2', input: '{"CommandLine":"Get-ChildItem -Name"}' },
    { type: 'tool-event', toolName: 'run_command', status: 'completed', callId: 'antigravity-step-2', input: '{"CommandLine":"Get-ChildItem -Name"}', output: 'alpha.txt', outputMode: 'snapshot' },
  ])
})

test('Antigravity 工具失败保留 Provider 的错误正文', async () => {
  const captured = {}
  const driver = driverWith([
    INIT,
    { event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'rm -rf /' }, error: { type: 'TOOL_ERROR', message: 'user denied permission' } } } },
    RESULT_OK,
  ], captured)
  const chunks = await collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x' }))
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-event'), [
    { type: 'tool-event', toolName: 'run_command', status: 'failed', callId: 'antigravity-step-1', input: '{"CommandLine":"rm -rf /"}', error: 'user denied permission' },
  ])
})

test('Antigravity 的 result(error) 抛出原始原因，不伪装成通用失败', async () => {
  const captured = {}
  const driver = driverWith([
    INIT,
    { event: 'result', result: { status: 'ERROR', error: 'invalid model selection (--model "nope")', usage: { input_tokens: 0, output_tokens: 0 } } },
  ], captured)
  await assert.rejects(collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x' })), /invalid model selection/u)
})

test('Antigravity 回合被自动拒绝且没有正文时给出可诊断错误', async () => {
  const captured = {}
  const driver = driverWith([
    INIT,
    { event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } },
  ], captured)
  await assert.rejects(collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x' })), /被自动拒绝（RunCommand）/u)
})

test('Antigravity 取消时先关闭 stdin 再终止进程', async () => {
  const captured = { keepOpen: true }
  const controller = new AbortController()
  const driver = driverWith((child) => {
    setTimeout(() => { controller.abort(); child.stdout.end() }, 5)
    return []
  }, captured)
  const chunks = await collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x', signal: controller.signal }))
  assert.equal(captured.child.state.stdinEnded, true)
  assert.equal(captured.child.state.killed, true)
  assert.equal(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason === 'cancel'), true)
})

test('Antigravity 子进程没有输出就退出时快速失败而不是挂起', async () => {
  const driver = driverWith([], {})
  await assert.rejects(collect(driver.executeTurn({ sessionId: 's1', messages: [], prompt: 'x' })), /Antigravity 执行失败/u)
})

test('Antigravity 模型目录按制表符解析，忽略进度噪音，空结果回退静态目录', async () => {
  const driver = driverWith([])
  const catalog = await driver.listModels()
  assert.equal(catalog.groups.length, 1)
  assert.deepEqual(catalog.groups[0]?.models, [{ id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', efforts: [] }])

  const noisy = new AntigravityDriver({
    spawnSync: ((command, args) => args[0] === '--version'
      ? { status: 0, stdout: '1.2.1', stderr: '' }
      : { status: 0, stdout: 'Fetching available models...\nnot a model line\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n', stderr: '' }) as never,
  })
  assert.deepEqual((await noisy.listModels()).groups[0]?.models, [{ id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', efforts: [] }])

  const empty = new AntigravityDriver({
    spawnSync: ((command, args) => args[0] === '--version'
      ? { status: 0, stdout: '1.2.1', stderr: '' }
      : { status: 1, stdout: '', stderr: 'not authenticated' }) as never,
  })
  // 静态候选必须还是同一个对象，Host 才能识别出"这是内置回退"。
  assert.equal(await empty.listModels(), ANTIGRAVITY_CATALOG)
})

test('Antigravity 附件以路径引用传递并开放所在目录', async () => {
  const captured = {}
  const driver = driverWith([INIT, RESULT_OK], captured)
  await collect(driver.executeTurn({
    sessionId: 's1',
    messages: [],
    prompt: '看图',
    attachments: [{ kind: 'image', path: 'C:\\tmp\\shots\\a.png', name: 'a.png' }],
  }))
  const addDirIndex = captured.args.indexOf('--add-dir')
  assert.notEqual(addDirIndex, -1)
  assert.equal(captured.args[addDirIndex + 1], 'C:\\tmp\\shots')
  const sent = JSON.parse(captured.child.state.written.trim())
  assert.match(sent.message.content[0].text, /@C:\\tmp\\shots\\a\.png/u)
})
