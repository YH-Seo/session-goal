import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Goal } from '../types'

const goal = atom({ plugin: 'session-goal', key: 'goal' } as const, null)
const isHintHidden = atom(
  { plugin: 'session-goal', key: 'isHintHidden' } as const,
  false,
)
const skipNextJudgement = atom(
  { plugin: 'session-goal', key: 'skipNextJudgement' } as const,
  false,
)
const suggestion = atom(
  { plugin: 'session-goal', key: 'suggestion' } as const,
  null,
)
const hasSuggested = atom(
  { plugin: 'session-goal', key: 'hasSuggested' } as const,
  false,
)

// $.state lives only while the app runs; mirror what must outlast a restart.
type Saved = { goal: Goal | null; isHintHidden: boolean; hasSuggested: boolean }

const STORE_PREFIX = 'session:'
const MAX_SAVED_SESSIONS = 200

const storeKey = async ($: EngineInterface) =>
  `${STORE_PREFIX}${await $.session.id()}`

const save = async ($: EngineInterface) => {
  const snapshot: Saved = {
    goal: await read($, goal),
    isHintHidden: await read($, isHintHidden),
    hasSuggested: await read($, hasSuggested),
  }

  try {
    await $.store.set(await storeKey($), snapshot)
  } catch (error) {
    $.ui.toast(`session-goal: 목표를 저장하지 못했습니다. ${String(error)}`)
  }
}

const changeGoal = async (
  $: EngineInterface,
  fn: (current: Goal | null) => Goal | null,
) => {
  await update($, goal, fn)
  await save($)
}

const hideHint = async ($: EngineInterface) => {
  await update($, isHintHidden, () => true)
  await save($)
}

const markSuggested = async ($: EngineInterface) => {
  await update($, hasSuggested, () => true)
  await save($)
}

const isSaved = (value: unknown): value is Saved =>
  typeof value === 'object' &&
  value !== null &&
  'goal' in value &&
  'isHintHidden' in value &&
  'hasSuggested' in value

const restore = async ($: EngineInterface) => {
  const saved = await $.store.get(await storeKey($))

  if (isSaved(saved)) {
    await update($, goal, () => saved.goal)
    await update($, isHintHidden, () => saved.isHintHidden)
    await update($, hasSuggested, () => saved.hasSuggested)

    if (saved.goal !== null) {
      await update($, suggestion, () => null)
    }
  }

  const keys = (await $.store.keys()).filter(key => key.startsWith(STORE_PREFIX))

  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_SESSIONS))) {
    await $.store.delete(key)
  }
}

const titleOf = (text: string) =>
  text.length > 40 ? `${text.slice(0, 40)}…` : text

const judgePrompt = (target: Goal) =>
  [
    '[session-goal 평가] 이 메시지는 자동 평가입니다. 작업을 이어 가지 말고 판정만 하세요.',
    `세션 목표: ${target.text}`,
    '지금까지의 대화에서 목표가 끝났다는 근거가 있는지 엄격하게 판정하세요.',
    '근거가 대화에 없거나, 일부가 남았거나, 검증되지 않았으면 NOT_MET입니다.',
    target.isRejected
      ? '사용자가 이전의 달성 판정을 거부했습니다. 그 이후의 새 근거가 있을 때만 MET입니다.'
      : '',
    '첫 줄에 `MET: <한 문장 근거>` 또는 `NOT_MET: <한 문장 근거>`만 쓰세요.',
  ]
    .filter(Boolean)
    .join('\n')

const parseMet = (reply: string) => {
  const line = reply.trim().split('\n')[0] ?? ''
  const match = /^MET\s*:\s*(.+)$/.exec(line)

  return match?.[1]?.trim() ?? null
}

const judge = async ($: EngineInterface, target: Goal) => {
  const reply = await $.model.fork({ prompt: judgePrompt(target) })

  if (!reply.isAnswered) {
    return
  }

  const reason = parseMet(reply.text)

  if (reason === null) {
    return
  }

  await changeGoal($, current =>
    current?.text === target.text && current.status === 'active'
      ? { ...current, status: 'met' as const, reason }
      : current,
  )
}

const suggestPrompt = [
  '[session-goal 추정] 이 메시지는 자동 추정입니다. 작업을 이어 가지 말고 답만 하세요.',
  '지금까지의 대화에서 사용자가 이 세션에서 이루려는 목표를 추정하세요.',
  '목표가 분명하면 첫 줄에 `GOAL: <목표와 완료 조건을 담은 한 문장>`만 쓰세요.',
  '대화가 짧거나 단순 질문이라 목표를 알 수 없으면 `NONE`만 쓰세요.',
].join('\n')

export const parseSuggestedGoal = (reply: string) => {
  const line = reply.trim().split('\n')[0] ?? ''
  const match = /^GOAL\s*:\s*(.+)$/.exec(line)

  return match?.[1]?.trim() ?? null
}

const suggest = async ($: EngineInterface) => {
  const reply = await $.model.fork({ prompt: suggestPrompt })

  if (!reply.isAnswered) {
    return
  }

  const text = parseSuggestedGoal(reply.text)

  if (text === null || (await read($, goal)) !== null) {
    return
  }

  await update($, suggestion, () => text)
}

const askClaude = ($: EngineInterface, text: string) => {
  // A command.run hook may not submit a prompt: the host would deadlock on it.
  void $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch((error: unknown) => {
      $.ui.toast(`session-goal: Claude에게 요청을 보내지 못했습니다. ${String(error)}`)
    })
  })
}

const setGoal = async ($: EngineInterface, text: string) => {
  await changeGoal($, () => ({ text, status: 'active' }))
  await update($, suggestion, () => null)
  await update($, skipNextJudgement, () => true)
  askClaude(
    $,
    [
      `세션 목표가 설정됐습니다: ${text}`,
      `mcp__ccd_session_mgmt__set_session_title로 이 세션(session_id "self")의 제목을 "목표: ${titleOf(text)}"로 바꾸세요.`,
      '제목 변경 외의 작업은 시작하지 말고, 한 문장으로만 답하세요.',
    ].join('\n'),
  )
}

const finishGoal = async (
  $: EngineInterface,
  target: Goal,
  isOpenPending = false,
) => {
  await changeGoal($, () => ({
    ...target,
    status: 'done' as const,
    isOpenPending,
  }))
  await update($, skipNextJudgement, () => true)
  askClaude(
    $,
    [
      `세션 목표가 완료 처리됐습니다: ${target.text}`,
      `1. mcp__ccd_session_mgmt__set_session_title로 이 세션(session_id "self")의 제목을 "[완료] ${titleOf(target.text)}"로 바꾸세요.`,
      '2. 다음 세션에 넘길 일이 있으면, 새 세션의 첫 메시지로 그대로 쓸 인계 프롬프트를 ```handoff 코드 블록 하나에 쓰세요.',
      '   이 대화를 못 본 사람도 이해하게 남은 일·관련 파일·결정 사항·끝난 상태를 담고, 넘길 일이 없으면 블록을 쓰지 마세요.',
      '새 세션은 입력창 위 띠가 인계 프롬프트를 채워 엽니다. new_session 액션은 쓰지 마세요.',
      '추가 작업은 시작하지 마세요.',
    ].join('\n'),
  )
}

const NEW_SESSION_URL = 'claude://code/new?source=desktop_action'
// Long deep links can be cut by the OS; keep the prefilled prompt short enough.
const MAX_HANDOFF_LENGTH = 4000

const HANDOFF_BLOCK = /```handoff[^\n]*\n([\s\S]*?)\n```/

export const parseHandoff = (text: string) => {
  const body = HANDOFF_BLOCK.exec(text)?.[1]?.trim()

  return body ? body.slice(0, MAX_HANDOFF_LENGTH) : null
}

export const newSessionUrl = (handoff?: string) =>
  handoff
    ? `${NEW_SESSION_URL}&q=${encodeURIComponent(handoff)}`
    : NEW_SESSION_URL

const openNewSession = async ($: EngineInterface, handoff?: string) => {
  const { exitCode } = await $.process.run(['open', newSessionUrl(handoff)])

  if (exitCode !== 0) {
    $.ui.toast('session-goal: 새 세션 화면을 열지 못했습니다. 사이드바에서 시작해 주세요.')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A failed restore must not keep the commands from registering.
    await restore($).catch(() => undefined)
    await $.command.register({
      name: 'session-goal',
      description: '이 세션의 목표를 설정합니다 (clear로 해제)',
      argumentHint: '[목표 | clear]',
    })
    await $.command.register({
      name: 'session-done',
      description: '세션 목표를 완료 처리하고 새 세션을 안내합니다',
    })

    return next(e)
  })

  on('command.run', { command: 'session-goal' }, async ($, e) => {
    const text = e.args.trim()

    if (text === 'clear') {
      await changeGoal($, () => null)
      await update($, suggestion, () => null)

      return { text: '세션 목표를 해제했습니다.' }
    }

    if (text === '') {
      const current = await read($, goal)

      return {
        text: current
          ? `현재 목표: ${current.text}`
          : '사용법: /session-goal <목표와 완료 조건>',
      }
    }

    await setGoal($, text)

    return { text: `세션 목표를 설정했습니다: ${text}` }
  })

  on('command.run', { command: 'session-done' }, async $ => {
    const current = await read($, goal)

    if (current === null) {
      return { text: '설정된 세션 목표가 없습니다.' }
    }

    await finishGoal($, current)

    return { text: `세션 목표를 완료 처리했습니다: ${current.text}` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    const finished = await read($, goal)

    if (finished?.status === 'done' && finished.handoff === undefined) {
      const handoff = parseHandoff(result.text)

      if (handoff !== null || finished.isOpenPending) {
        await changeGoal($, current =>
          current === null
            ? current
            : { ...current, handoff: handoff ?? '', isOpenPending: false },
        )
      }

      if (finished.isOpenPending) {
        await openNewSession($, handoff ?? undefined)
      }
    }

    if (await read($, skipNextJudgement)) {
      await update($, skipNextJudgement, () => false)

      return result
    }

    const current = await read($, goal)

    if (e.reason === 'answer' && current?.status === 'active') {
      void $.clock.after(0, () => {
        void judge($, current)
      })
    }

    if (
      e.reason === 'answer' &&
      current === null &&
      !(await read($, hasSuggested)) &&
      !(await read($, isHintHidden))
    ) {
      // One extra model call per session: the first answered turn without a goal.
      await markSuggested($)
      void $.clock.after(0, () => {
        void suggest($)
      })
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const current = await read($, goal)
    const { Box, Button, Text } = $.ui.resolve(e)

    // One look for every state: a rounded card whose border and badge take
    // the state's colour, the goal as its title, buttons along the bottom.
    const card = (look: {
      key: string
      tone: string
      badge: string
      title: string
      note?: string
      buttons: RenderChildren
    }) => (
      <Box
        key={look.key}
        flexDirection="column"
        borderStyle="round"
        borderColor={look.tone}
        paddingX="md"
        paddingY="xs"
        gap="xs"
        hover={{ borderStyle: 'bold' }}
      >
        <Text color={look.tone} size="footnote" weight="semibold">
          {look.badge}
        </Text>
        <Text size="heading" weight="semibold" wrap="wrap">
          {look.title}
        </Text>
        {look.note ? (
          <Text dimColor size="footnote" wrap="wrap">
            {look.note}
          </Text>
        ) : null}
        <Box gap="sm" flexWrap="wrap">
          {look.buttons}
        </Box>
      </Box>
    )

    if (current === null) {
      if (await read($, isHintHidden)) {
        return next(e)
      }

      const suggested = await read($, suggestion)

      if (suggested !== null) {
        return card({
          key: 'card-suggested',
          tone: 'suggestion',
          badge: '✦ 추정 목표',
          title: suggested,
          note: '대화를 보고 추정한 목표입니다. 다르면 /session-goal <목표>로 직접 설정하세요.',
          buttons: [
            <Button
              key="accept"
              variant="primary"
              label="이 목표로 설정"
              onPress={() => setGoal($, suggested)}
            />,
            <Button
              key="skip"
              variant="secondary"
              label="건너뛰기"
              onPress={async () => {
                await update($, suggestion, () => null)
                await hideHint($)
              }}
            />,
          ],
        })
      }

      return card({
        key: 'card-empty',
        tone: 'subtle',
        badge: '◎ 세션 목표 없음',
        title: '이 세션에서 끝낼 일을 정해 두세요',
        note: '/session-goal <목표와 완료 조건>으로 설정합니다.',
        buttons: [
          <Button
            key="skip"
            variant="secondary"
            label="건너뛰기"
            onPress={() => hideHint($)}
          />,
        ],
      })
    }

    if (current.status === 'done') {
      return card({
        key: 'card-done',
        tone: 'merged',
        badge: '★ 목표 완료',
        title: current.text,
        note: current.handoff
          ? '인계 내용을 채워 새 세션을 엽니다.'
          : undefined,
        buttons: [
          <Button
            key="new-session"
            variant="primary"
            label={current.handoff ? '인계해서 새 세션 열기' : '새 세션 열기'}
            onPress={() => openNewSession($, current.handoff || undefined)}
          />,
        ],
      })
    }

    if (current.status === 'met') {
      return card({
        key: 'card-met',
        tone: 'success',
        badge: '✓ 달성한 것으로 보입니다',
        title: current.text,
        note: current.reason,
        buttons: [
          <Button
            key="finish"
            variant="primary"
            label="완료하고 새 세션으로"
            onPress={async () => {
              // Opens once Claude has written the handoff (turn.complete).
              await finishGoal($, current, true)
            }}
          />,
          <Button
            key="finish-only"
            variant="secondary"
            label="완료만"
            onPress={() => finishGoal($, current)}
          />,
          <Button
            key="reject"
            variant="secondary"
            label="아직 아닙니다"
            onPress={() =>
              changeGoal($, () => ({
                text: current.text,
                status: 'active' as const,
                isRejected: true,
              }))
            }
          />,
        ],
      })
    }

    return card({
      key: 'card-active',
      tone: 'claude',
      badge: current.isRejected ? '● 진행 중 · 재판정 대기' : '● 진행 중',
      title: current.text,
      buttons: [
        <Button
          key="done"
          variant="secondary"
          label="완료"
          onPress={() => finishGoal($, current)}
        />,
      ],
    })
  })
}
