import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gitStore from '../../lib/coordination/git-store.mjs';
import { createRequirementWorktree, gitCommonDir, initializeSession } from '../../lib/coordination/worktrees.mjs';
import { claimRequirement, bindRequirementVersion } from '../../lib/coordination/requirements.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

test('coordination preserves repository SSH transport and explicit caller overrides', t => {
  const { clientA: cwd } = createGitFixture(t);
  runGit(cwd, ['config', 'core.sshCommand', 'ssh -i /fixture/configured-key']);
  assert.equal(typeof gitStore.coordinationGitEnvironment, 'function');
  assert.equal(gitStore.coordinationGitEnvironment({ cwd, env: {} }).GIT_SSH_COMMAND, undefined);
  assert.equal(gitStore.coordinationGitEnvironment({ cwd, env: { GIT_SSH_COMMAND: 'ssh -i /fixture/explicit-key' } }).GIT_SSH_COMMAND, 'ssh -i /fixture/explicit-key');
  runGit(cwd, ['config', '--unset', 'core.sshCommand']);
  assert.equal(gitStore.coordinationGitEnvironment({ cwd, env: {} }).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
});

async function workstream(t) {
  const fixture = createGitFixture(t), cwd = fixture.clientA;
  const store = new gitStore.GitCoordinationStore({ cwd, remote: 'origin', branch: 'coordination', tempRoot: fixture.tempRoot });
  await store.initialize();
  const requirement = await claimRequirement({ store, type: 'I', title: 'recover interrupted creation', profile: 'tooling', backlogText: '| I-001 | fixture |\n' });
  await bindRequirementVersion({ store, id: requirement.id, version: 'v1.0.1' });
  const session = initializeSession({ cwd, agent: 'test', user: 'owner', host: 'fixture' });
  return { cwd, store, id: requirement.id, session, topic: 'recover-creation' };
}

test('failed initial binding cleans only its untouched new branch so create can retry', async t => {
  const s = await workstream(t), update = s.store.update.bind(s.store);
  let once = true;
  s.store.update = args => {
    if (once && args.operation.startsWith('bind worktree branch')) { once = false; throw new Error('fixture binding interrupted'); }
    return update(args);
  };
  await assert.rejects(createRequirementWorktree(s), /fixture binding interrupted/);
  const recovered = await createRequirementWorktree(s);
  assert.equal(recovered.requirementId, s.id);
  assert.equal(runGit(recovered.path, ['branch', '--show-current']), `feature/${s.id}/recover-creation`);
});

test('failed binding preserves any files created in the worktree while coordination was pending', async t => {
  const s = await workstream(t), path = join(s.cwd, '.worktrees', `${s.id}-${s.topic}`);
  s.store.update = args => {
    if (args.operation.startsWith('bind worktree branch')) {
      writeFileSync(join(path, 'keep-work.txt'), 'concurrent work must survive\n');
      throw new Error('fixture binding interrupted');
    }
    throw new Error('unexpected update');
  };
  await assert.rejects(createRequirementWorktree(s), /fixture binding interrupted/);
  assert.equal(existsSync(join(path, 'keep-work.txt')), true);
});

for (const receipt of ['missing', 'matching', 'changed-branch']) test(`orphan branch recovery preserves existing work (${receipt})`, async t => {
  const s = await workstream(t), branch = `feature/${s.id}/${s.topic}`;
  const path = join(realpathSync(s.cwd), '.worktrees', `${s.id}-${s.topic}`);
  const baseCommit = runGit(s.cwd, ['rev-parse', 'origin/main']);
  runGit(s.cwd, ['branch', branch, baseCommit]);
  if (receipt !== 'missing') {
    const root = join(gitCommonDir(s.cwd), 'coordination/worktree-creation');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${s.id}.json`), JSON.stringify({ requirementId: s.id, branch, path, baseCommit }));
  }
  if (receipt === 'changed-branch') {
    runGit(s.cwd, ['switch', branch]);
    runGit(s.cwd, ['commit', '--allow-empty', '-m', 'concurrent work must survive']);
    runGit(s.cwd, ['switch', 'main']);
  }
  const previous = runGit(s.cwd, ['rev-parse', branch]);
  if (receipt === 'matching') {
    const result = await createRequirementWorktree(s);
    assert.equal(result.path, path);
    assert.equal(runGit(path, ['merge-base', previous, 'HEAD']), previous);
  } else {
    await assert.rejects(createRequirementWorktree(s), { code: 'LOCAL_BRANCH_EXISTS' });
    assert.equal(runGit(s.cwd, ['rev-parse', branch]), previous);
    assert.equal(existsSync(path), false);
  }
});
