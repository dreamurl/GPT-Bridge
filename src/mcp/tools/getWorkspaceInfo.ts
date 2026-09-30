import * as path from 'node:path';
import * as vscode from 'vscode';
import { isListingExcluded } from '../../workspace/denyList';
import { getGitWorkspaceSummary } from '../../workspace/gitStatus';
import { textResult, type ToolContext, type ToolResult } from './types';

const FILE_SCAN_LIMIT = 20_000;
const TOP_LANGUAGES = 6;
const MAX_OPEN_TABS = 20;

export const GET_WORKSPACE_INFO_DESCRIPTION = `Return an overview of the currently open workspace.

**Call this first, at the start of any coding task.** It tells you the project
name, how many files there are, the dominant languages, which editors are open,
the Git branch and change counts, which file is active with the cursor position,
and a diagnostics summary.

When to use: the first turn of a conversation, and again after the user says
they switched projects.

Call order: get_workspace_info -> list_directory or search_text -> read_file

Takes no parameters.`;

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.c': 'C',
  '.h': 'C/C++ header',
  '.cpp': 'C++',
  '.swift': 'Swift',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.sql': 'SQL',
  '.sh': 'Shell'
};

export async function getWorkspaceInfoTool(ctx: ToolContext): Promise<ToolResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return textResult('No workspace folder is open. Open a folder in VS Code first.');
  }

  const sections: string[] = [`Workspace: ${folder.name}`];

  // ── 파일 수 / 주요 언어 ──────────────────────────────────────────
  if (ctx.rg === undefined) {
    sections.push('File statistics: unavailable because the ripgrep binary was not found.');
  } else {
    const outcome = await ctx.rg.listFiles(ctx.root, { relativeDir: '', limit: FILE_SCAN_LIMIT });
    const counted = outcome.files.filter(
      (file) => !isListingExcluded(file) && !ctx.guard.deny.isDenied(file)
    );

    const byLanguage = new Map<string, number>();
    for (const file of counted) {
      const language = EXTENSION_LANGUAGES[path.extname(file).toLowerCase()];
      if (language !== undefined) {
        byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
      }
    }

    const top = [...byLanguage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_LANGUAGES)
      .map(([language, count]) => `${language} ${count}`);

    const suffix = outcome.truncated ? '+' : '';
    sections.push(`Files: ${counted.length}${suffix} (.gitignore and node_modules excluded)`);
    sections.push(`Main languages: ${top.length > 0 ? top.join(', ') : 'undetermined'}`);
  }

  // ── Git 브랜치 / 변경 요약 ─────────────────────────────────────
  sections.push(await getGitWorkspaceSummary(ctx.root));

  // ── 열린 편집기 ─────────────────────────────────────────────────
  const openPaths: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (
        typeof input === 'object' &&
        input !== null &&
        'uri' in input &&
        (input as { uri: vscode.Uri }).uri.scheme === 'file'
      ) {
        const relative = toRelative(ctx.root, (input as { uri: vscode.Uri }).uri.fsPath);
        if (relative !== undefined && !ctx.guard.deny.isDenied(relative)) {
          openPaths.push(tab.isDirty ? `${relative} (unsaved)` : relative);
        }
      }
    }
  }

  sections.push(
    openPaths.length > 0
      ? `Open editors (${openPaths.length}):
${openPaths
          .slice(0, MAX_OPEN_TABS)
          .map((entry) => `  - ${entry}`)
          .join('\n')}`
      : 'Open editors: none'
  );

  // ── 활성 파일과 선택 영역 ────────────────────────────────────────
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    sections.push('Active file: none');
  } else {
    const relative = toRelative(ctx.root, editor.document.uri.fsPath);
    if (relative === undefined || ctx.guard.deny.isDenied(relative)) {
      sections.push('Active file: outside the workspace or access is blocked');
    } else {
      const selection = editor.selection;
      const position = selection.isEmpty
        ? `cursor at line ${selection.active.line + 1}`
        : `selection lines ${selection.start.line + 1}-${selection.end.line + 1}`;
      const dirty = editor.document.isDirty ? ', unsaved' : '';
      sections.push(`Active file: ${relative} (${position}${dirty})`);
    }
  }

  // ── 진단 요약 ───────────────────────────────────────────────────
  let errors = 0;
  let warnings = 0;
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file' || toRelative(ctx.root, uri.fsPath) === undefined) {
      continue;
    }
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        errors += 1;
      } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
        warnings += 1;
      }
    }
  }
  sections.push(`Diagnostics: ${errors} error(s), ${warnings} warning(s) (details via get_diagnostics)`);

  return textResult(sections.join('\n'));
}

/** 워크스페이스 밖이면 undefined. */
function toRelative(root: string, fsPath: string): string | undefined {
  const relative = path.relative(root, fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}
