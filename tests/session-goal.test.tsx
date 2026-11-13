import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'session-goal',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const TURN = {
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
} as const

const setUp = async (
  $: Engine,
  on: On,
  verdict: string,
  {
    withGoal = true,
    stored = {},
  }: { withGoal?: boolean; stored?: Record<string, unknown> } = {},
) => {
  const clock = mock.clock(on)
  // The test's own store, so a test can look at what the plugin left in it.
  const store = new Map<string, unknown>(Object.entries(stored))

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'sess-1' }))
  const prompts: string[] = []
  let judgements = 0
  let answer = ''

  on('ui.toast', (_, e) => {
    prompts.push(`toast: ${JSON.stringify(e)}`)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    prompts.push(`open: ${e.argv.join(' ')}`)

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('turn.complete', () => ({ text: answer }))
  on('model.fork', () => {
    judgements += 1

    return { value: { isAnswered: true, text: verdict, usage: USAGE } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  if (withGoal) {
    await $.command.run({
      command: 'session-goal',
      args: '로그인 버그 수정',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    await clock.advance(0)
  }

  return {
    store,
    clock,
    prompts,
    judgements: () => judgements,
    answerWith: (text: string) => {
      answer = text
    },
  }
}

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

test('setting a goal asks for the title and skips judging that turn', async ($, on) => {
  const { clock, prompts, judgements } = await setUp($, on, 'MET: fixed')

  expect(prompts[0]).toContain('목표: 로그인 버그 수정')
  await $.turn.complete(TURN)
  await clock.advance(0)
  expect(judgements()).toBe(0)
})

test('a MET verdict offers a new session and starts no work', async ($, on) => {
  const { clock, prompts, judgements, answerWith } = await setUp(
    $,
    on,
    'MET: fixed',
  )

  await $.turn.complete(TURN)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(0)
  expect(judgements()).toBe(1)
  expect(prompts.length).toBe(1)

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /달성/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /로그인/ })).not.toBe(undefined)
  await ui.press({ key: 'finish' })
  await clock.advance(0)
  expect(prompts.some(text => text.startsWith('open:'))).toBe(false)
  expect(prompts.some(text => text.includes('[완료]'))).toBe(true)

  answerWith('정리했습니다.\n\n```handoff\n남은 일: 배포 확인\n```\n')
  await $.turn.complete({ ...TURN, turnId: 't3' })
  await clock.advance(0)
  expect(prompts).toContain(
    `open: open claude://code/new?source=desktop_action&q=${encodeURIComponent('남은 일: 배포 확인')}`,
  )
  await ui.unmount()
})

test('a NOT_MET verdict keeps the goal active', async ($, on) => {
  const { clock } = await setUp($, on, 'NOT_MET: tests remain')

  await $.turn.complete(TURN)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(0)

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /진행 중/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /로그인/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /달성/ })).toBe(undefined)
  await ui.unmount()
})

test('a built-in goal name is not registered', async ($, on) => {
  const names: string[] = []

  on('command.register', (_, e) => {
    names.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(names.includes('goal')).toBe(false)
  expect(names).toEqual(['session-goal', 'session-done'])
})

test('without a handoff block the new session opens empty', async ($, on) => {
  const { clock, prompts } = await setUp($, on, 'MET: fixed')

  await $.command.run({
    command: 'session-done',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  await clock.advance(0)
  await $.turn.complete(TURN)
  await clock.advance(0)

  const ui = await $.ui.mount(BAND)

  await ui.press({ key: 'new-session' })
  expect(prompts).toContain('open: open claude://code/new?source=desktop_action')
  await ui.unmount()
})

test('without a goal the first answered turn suggests one from the chat', async ($, on) => {
  const { clock, prompts, judgements } = await setUp($, on, 'GOAL: 결제 오류 수정', {
    withGoal: false,
  })

  await $.turn.complete(TURN)
  await clock.advance(0)
  expect(judgements()).toBe(1)

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /추정 목표/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /결제 오류/ })).not.toBe(undefined)
  await ui.press({ key: 'accept' })
  await clock.advance(0)
  expect(prompts[0]).toContain('목표: 결제 오류 수정')
  expect(await ui.find({ type: 'Text', text: /추정 목표/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /진행 중/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /결제 오류/ })).not.toBe(undefined)
  await ui.unmount()
})

test('the suggestion runs once per session and skipping hides the hint', async ($, on) => {
  // Stands for the engine's own band once the mod draws nothing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const { clock, judgements } = await setUp($, on, 'GOAL: 결제 오류 수정', {
    withGoal: false,
  })

  await $.turn.complete(TURN)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(0)
  expect(judgements()).toBe(1)

  const ui = await $.ui.mount(BAND)

  await ui.press({ key: 'skip' })
  expect(await ui.find({ type: 'Text', text: /추정 목표/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /세션 목표 없음/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await $.turn.complete({ ...TURN, turnId: 't3' })
  await clock.advance(0)
  expect(judgements()).toBe(1)
  await ui.unmount()
})

test('a NONE reply keeps the plain hint', async ($, on) => {
  const { clock, judgements } = await setUp($, on, 'NONE', { withGoal: false })

  await $.turn.complete(TURN)
  await clock.advance(0)
  expect(judgements()).toBe(1)

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /추정 목표/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /세션 목표 없음/ })).not.toBe(undefined)
  await ui.unmount()
})

test('a goal set before an app restart comes back and no goal is suggested', async ($, on) => {
  const { clock, judgements } = await setUp($, on, 'GOAL: 결제 오류 수정', {
    withGoal: false,
    stored: {
      'session:sess-1': {
        goal: { text: '로그인 버그 수정', status: 'active' },
        isHintHidden: false,
        hasSuggested: false,
      },
    },
  })

  await $.turn.complete(TURN)
  await clock.advance(0)
  // The one model call judges the restored goal; it does not suggest a new one.
  expect(judgements()).toBe(1)

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /추정 목표/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /진행 중/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /로그인 버그/ })).not.toBe(undefined)
  await ui.unmount()
})

test('setting a goal saves it for the next start of the session', async ($, on) => {
  const { clock } = await setUp($, on, 'NOT_MET: no')

  await clock.advance(0)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /진행 중/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /로그인 버그/ })).not.toBe(undefined)
  await ui.unmount()
})

test('finishing only marks the goal done and opens no session', async ($, on) => {
  const { clock, prompts, answerWith } = await setUp($, on, 'MET: fixed')

  await $.turn.complete(TURN)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(0)

  const ui = await $.ui.mount(BAND)

  await ui.press({ key: 'finish-only' })
  await clock.advance(0)
  expect(prompts.some(text => text.includes('[완료]'))).toBe(true)

  answerWith('정리했습니다.\n\n```handoff\n남은 일: 배포 확인\n```\n')
  await $.turn.complete({ ...TURN, turnId: 't3' })
  await clock.advance(0)
  expect(prompts.some(text => text.startsWith('open:'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /목표 완료/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /로그인/ })).not.toBe(undefined)
  expect(await ui.find({ key: 'new-session' })).not.toBe(undefined)
  await ui.unmount()
})

const DAY_MS = 24 * 60 * 60 * 1000

test('a finished goal survives an app restart with its card', async ($, on) => {
  await setUp($, on, 'NOT_MET: no', {
    withGoal: false,
    stored: {
      'session:sess-1': {
        goal: { text: '로그인 버그 수정', status: 'done', handoff: '남은 일: 배포 확인' },
        isHintHidden: false,
        hasSuggested: true,
        updatedAt: 0,
      },
    },
  })

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /목표 완료/ })).not.toBe(undefined)
  expect(await ui.find({ key: 'new-session' })).not.toBe(undefined)
  await ui.unmount()
})

test('clearing the goal removes its stored row', async ($, on) => {
  const { store } = await setUp($, on, 'NOT_MET: no')

  expect(store.has('session:sess-1')).toBe(true)
  await $.command.run({
    command: 'session-goal',
    args: 'clear',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(store.has('session:sess-1')).toBe(false)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /세션 목표 없음/ })).not.toBe(undefined)
  await ui.unmount()
})

test('a start drops rows of sessions untouched for 90 days and keeps the rest', async ($, on) => {
  const { clock, store } = await setUp($, on, 'NOT_MET: no', {
    withGoal: false,
    stored: {
      'session:old': {
        goal: { text: '옛 목표', status: 'done' },
        isHintHidden: false,
        hasSuggested: true,
        updatedAt: 0,
      },
      'session:recent': {
        goal: { text: '최근 목표', status: 'active' },
        isHintHidden: false,
        hasSuggested: true,
        updatedAt: 0,
      },
      'session:unstamped': {
        goal: { text: '0.4.0 목표', status: 'active' },
        isHintHidden: false,
        hasSuggested: true,
      },
      'session:broken': 'not a row',
    },
  })

  await clock.advance(91 * DAY_MS)
  store.set('session:recent', {
    goal: { text: '최근 목표', status: 'active' },
    isHintHidden: false,
    hasSuggested: true,
    updatedAt: clock.now(),
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const keys = [...store.keys()]

  expect(keys).not.toContain('session:old')
  expect(keys).not.toContain('session:broken')
  expect(keys).toContain('session:recent')
  expect(keys).toContain('session:unstamped')
})
