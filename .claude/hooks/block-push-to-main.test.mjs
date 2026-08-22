// Tests for the push-to-main PreToolUse hook. Run from the repo root:
//
//   node .claude/hooks/block-push-to-main.test.mjs
//
// Deliberately plain Node rather than vitest: the hook lives outside both
// workspaces, and a test that needs `npm install` in a particular directory
// first is a test nobody runs.
//
// Assumes the checkout is NOT on main (the last case checks that a bare
// `git push` is allowed off main).

import { execFileSync } from 'node:child_process';

const cases = [
  // [command, shouldAsk]
  ['git push origin main', true],
  ['git push -u origin main', true],
  ['git push --force-with-lease origin main', true],
  ['git push origin HEAD:main', true],
  ['git push origin feature:main', true],
  ['git push origin +main', true],
  ['git push origin refs/heads/main', true],
  ['cd worker && git push origin main', true],
  ['npm test && git push -u origin master', true],
  ['git push origin main:main', true],

  ['git push -u origin claude/sandbox-todo-list-g9u3ox', false],
  ['git push --force-with-lease origin HEAD:sandbox', false],
  ['git push origin main:sandbox', false],
  ['git push origin HEAD:refs/heads/sandbox', false],
  ['git status', false],
  ['git log --oneline -1', false],
  ['echo "git push origin main"', false], // quoted text, not an actual push
  ['npm run deploy:sandbox', false],
];

let fail = 0;
for (const [command, shouldAsk] of cases) {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: process.cwd(),
    tool_input: { command },
  });
  const out = execFileSync('node', ['.claude/hooks/block-push-to-main.mjs'], {
    input: payload,
    encoding: 'utf8',
  });
  const asked = out.includes('"ask"');
  const ok = asked === shouldAsk;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ask=${String(asked).padEnd(5)} want=${String(shouldAsk).padEnd(5)} ${command}`);
}

// current branch is not main, so a bare `git push` should pass
const bare = execFileSync('node', ['.claude/hooks/block-push-to-main.mjs'], {
  input: JSON.stringify({ cwd: process.cwd(), tool_input: { command: 'git push' } }),
  encoding: 'utf8',
});
console.log(`${bare.includes('"ask"') ? 'FAIL' : 'ok  '}  bare 'git push' off main`);

// escape hatch
const escaped = execFileSync('node', ['.claude/hooks/block-push-to-main.mjs'], {
  input: JSON.stringify({ cwd: process.cwd(), tool_input: { command: 'git push origin main' } }),
  encoding: 'utf8',
  env: { ...process.env, UO_ALLOW_MAIN_PUSH: '1' },
});
console.log(`${escaped.includes('"ask"') ? 'FAIL' : 'ok  '}  UO_ALLOW_MAIN_PUSH=1 escape hatch`);

console.log(fail === 0 ? '\nall refspec cases passed' : `\n${fail} FAILURES`);
