import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DevProjectInfo {
  name: string;
  path: string;
  isGitRepo: boolean;
  updatedAt: number;
}

export interface DevFileInfo {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
}

function normalizeProjectName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!cleaned) {
    throw new Error('项目名不能为空。');
  }
  if (!/^[\w.-]+$/.test(cleaned)) {
    throw new Error('项目名仅支持字母、数字、下划线、中划线、点。');
  }
  return cleaned;
}

export class DevWorkspaceManager {
  resolveWorkspaceRoot(rawPath: string): string {
    const resolved = path.resolve(rawPath);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  listProjects(workspaceRoot: string): DevProjectInfo[] {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((item) => item.isDirectory())
      .map((item) => {
        const projectPath = path.join(root, item.name);
        const stat = fs.statSync(projectPath);
        const gitPath = path.join(projectPath, '.git');
        return {
          name: item.name,
          path: projectPath,
          isGitRepo: fs.existsSync(gitPath),
          updatedAt: stat.mtimeMs
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createProject(workspaceRoot: string, projectName: string): DevProjectInfo {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const safeName = normalizeProjectName(projectName);
    const projectPath = path.join(root, safeName);
    if (fs.existsSync(projectPath)) {
      throw new Error(`项目已存在：${safeName}`);
    }

    fs.mkdirSync(projectPath, { recursive: true });
    const now = Date.now();
    return {
      name: safeName,
      path: projectPath,
      isGitRepo: false,
      updatedAt: now
    };
  }

  async cloneProject(workspaceRoot: string, repoUrl: string, projectName?: string): Promise<DevProjectInfo> {
    if (!/^https?:\/\//i.test(repoUrl)) {
      throw new Error('仓库地址必须是 http/https URL。');
    }

    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const inferredName = projectName?.trim() || this.inferProjectName(repoUrl);
    const safeName = normalizeProjectName(inferredName);
    const projectPath = path.join(root, safeName);
    if (fs.existsSync(projectPath)) {
      throw new Error(`目标项目目录已存在：${safeName}`);
    }

    await execFileAsync('git', ['clone', repoUrl, safeName], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });

    const stat = fs.statSync(projectPath);
    return {
      name: safeName,
      path: projectPath,
      isGitRepo: true,
      updatedAt: stat.mtimeMs
    };
  }

  resolveProjectPath(workspaceRoot: string, projectName: string): string {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const safeName = normalizeProjectName(projectName);
    const projectPath = path.join(root, safeName);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error(`项目不存在：${safeName}`);
    }
    return projectPath;
  }

  listProjectFiles(projectPath: string, relativePath = '.'): DevFileInfo[] {
    const target = this.resolveInsideProject(projectPath, relativePath);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      throw new Error(`不是目录：${relativePath}`);
    }

    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries
      .map((entry) => {
        const abs = path.join(target, entry.name);
        const st = fs.statSync(abs);
        return {
          name: entry.name,
          relativePath: path.relative(projectPath, abs).replace(/\\/g, '/'),
          isDirectory: entry.isDirectory(),
          size: st.size
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, 200);
  }

  readProjectFile(projectPath: string, relativePath: string, maxLines = 200): string {
    const target = this.resolveInsideProject(projectPath, relativePath);
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      throw new Error(`不是文件：${relativePath}`);
    }

    const content = fs.readFileSync(target, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length <= maxLines) {
      return content;
    }
    return `${lines.slice(0, maxLines).join('\n')}\n\n... (已截断，共 ${lines.length} 行)`;
  }

  async runProjectCommand(projectPath: string, command: string): Promise<string> {
    const normalized = command.trim();
    if (!normalized) {
      throw new Error('命令不能为空。');
    }

    const allowed = [
      /^git\s+status(?:\s+.*)?$/i,
      /^git\s+branch(?:\s+.*)?$/i,
      /^git\s+log(?:\s+.*)?$/i,
      /^npm\s+test(?:\s+.*)?$/i,
      /^npm\s+run\s+test(?:\s+.*)?$/i,
      /^pnpm\s+test(?:\s+.*)?$/i,
      /^yarn\s+test(?:\s+.*)?$/i
    ];

    if (!allowed.some((rule) => rule.test(normalized))) {
      throw new Error('该命令未在白名单中。当前仅允许 git status/branch/log 与 *test* 命令。');
    }

    const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', normalized], {
      cwd: projectPath,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return output || '(命令执行成功，无输出)';
  }

  private resolveInsideProject(projectPath: string, relativePath: string): string {
    const resolvedProject = path.resolve(projectPath);
    const resolvedTarget = path.resolve(resolvedProject, relativePath || '.');
    const normalizedProject = resolvedProject.toLowerCase();
    const normalizedTarget = resolvedTarget.toLowerCase();

    if (normalizedTarget !== normalizedProject && !normalizedTarget.startsWith(`${normalizedProject}${path.sep}`)) {
      throw new Error(`路径越界，禁止访问项目外路径：${relativePath}`);
    }

    if (!fs.existsSync(resolvedTarget)) {
      throw new Error(`路径不存在：${relativePath}`);
    }

    return resolvedTarget;
  }

  private inferProjectName(repoUrl: string): string {
    const trimmed = repoUrl.replace(/\/+$/, '');
    const last = trimmed.split('/').pop() ?? 'project';
    return last.replace(/\.git$/i, '') || 'project';
  }
}
