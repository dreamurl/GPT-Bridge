import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER_BYTES = 1_048_576;

export interface GitStatusSummary {
  readonly branch: string;
  readonly oid: string | undefined;
  readonly upstream: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

/** Parse the stable machine-readable format documented by `git status --porcelain=v2`. */
export function parseGitStatus(output: string): GitStatusSummary {
  let branch = 'unknown';
  let oid: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length);
      oid = value === '(initial)' ? undefined : value;
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length);
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length);
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith('? ')) {
      untracked += 1;
      continue;
    }
    if (line.startsWith('u ')) {
      conflicted += 1;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const indexState = line[2];
      const worktreeState = line[3];
      if (indexState !== undefined && indexState !== '.') {
        staged += 1;
      }
      if (worktreeState !== undefined && worktreeState !== '.') {
        unstaged += 1;
      }
    }
  }

  return {
    branch,
    oid,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted
  };
}

export function formatGitStatus(summary: GitStatusSummary): string {
  const head =
    summary.branch === '(detached)'
      ? `detached at ${summary.oid?.slice(0, 12) ?? 'unknown commit'}`
      : `branch ${summary.branch}`;
  const tracking =
    summary.upstream === undefined
      ? ''
      : `, upstream ${summary.upstream} (ahead ${summary.ahead}, behind ${summary.behind})`;
  const totalChanges =
    summary.staged + summary.unstaged + summary.untracked + summary.conflicted;
  const state =
    totalChanges === 0
      ? 'clean'
      : `${summary.staged} staged, ${summary.unstaged} unstaged, ${summary.untracked} untracked, ${summary.conflicted} conflicted`;
  return `Git: ${head}${tracking}; ${state}`;
}

export async function getGitWorkspaceSummary(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C'
        }
      }
    );
    return formatGitStatus(parseGitStatus(stdout));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return 'Git: unavailable because Git was not found.';
    }
    return 'Git: not a repository or status is unavailable.';
  }
}
