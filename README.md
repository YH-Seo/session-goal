# session-goal

A Claude Code mod that gives a session one goal, shows it above the prompt and in the sidebar title, judges completion after each turn, and points you to a new session when the goal is done.

Unlike the built-in `/goal`, it never makes Claude keep working. It only judges and suggests.

## Install

At the prompt of a terminal session:

```
/plugin install session-goal --marketplace YH-Seo/session-goal
```

From a shell:

```bash
claude plugin install session-goal --marketplace YH-Seo/session-goal
```

## Usage

| Command | What it does |
| --- | --- |
| `/session-goal <goal and done condition>` | Sets the goal and renames the session to `목표: ...` |
| `/session-goal` | Shows the current goal |
| `/session-goal clear` | Clears the goal |
| `/session-done` | Marks the goal done and renames the session to `[완료] ...` |

When a session has no goal, the first answered turn makes one extra model call that reads the conversation and infers a goal. The band above the prompt then shows `추정 목표: ...` with a button to set it as the session goal and one to skip. If the conversation is too short to tell, the band keeps the plain hint. This runs once per session.

After each answered turn, one extra model call reads the conversation and judges the goal. When it looks met, the band above the prompt shows the reason with two buttons: finish and open a new session, or reject the verdict.

When you finish, Claude writes a handoff prompt in a ```` ```handoff ```` block. The new session opens with that prompt already in its input box (`claude://code/new?q=...`), so you only press send. With no block, the new session opens empty.

## Limits

- Opening a new session uses the `claude://code/new` link through macOS `open`, so that button works on macOS with the Claude desktop app only.
- The goal inference adds one model call per session that starts without a goal.
- The automatic judgement adds one model call per turn in sessions that have a goal.
- The handoff is cut at 4,000 characters to keep the link short.
- The UI text is in Korean.
