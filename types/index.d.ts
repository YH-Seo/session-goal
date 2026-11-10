export type Goal = {
  text: string
  status: 'active' | 'met' | 'done'
  reason?: string
  isRejected?: boolean
  /** Prompt to prefill in the next session; '' when Claude wrote none. */
  handoff?: string
  /** Open the new session as soon as the handoff turn ends. */
  isOpenPending?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-goal': {
      goal: Goal | null
      isHintHidden: boolean
      skipNextJudgement: boolean
      /** Goal inferred from the conversation, offered in the band until set or skipped. */
      suggestion: string | null
      /** The one inference per session has run (or been skipped). */
      hasSuggested: boolean
    }
  }
}
