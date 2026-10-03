import * as fs from "./fs.ts";
import { resolveWorkspacePath, WorkspaceError } from "./ws.ts";

export interface ResolveJumpTargetInput {
  root: string;
  workspacePrefix?: string;
  workspaceName?: string;
  cwd?: string;
}

export interface JumpTarget {
  name: string;
  path: string;
}

export async function resolveJumpTarget(input: ResolveJumpTargetInput): Promise<JumpTarget> {
  const wsPath = resolveWorkspacePath({
    root: input.root,
    workspacePrefix: input.workspacePrefix,
    workspaceName: input.workspaceName,
    cwd: input.cwd,
  });
  const segments = wsPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = input.workspaceName || segments[segments.length - 1] || "workspace";
  if (!(await fs.isDirectory(wsPath))) {
    throw new WorkspaceError("WORKSPACE_NOT_FOUND", `Workspace '${name}' not found at ${wsPath}`, {
      workspaceName: name,
      path: wsPath,
      kind: "workspace",
      value: name,
      candidates: [],
    });
  }
  return {
    name,
    path: wsPath,
  };
}

export type ShellRunner = "direct" | "mise";

export const DEFAULT_SHELL_BY_PLATFORM = { win32: "powershell", other: "bash" } as const;
export const DEFAULT_SHELL =
  process.platform === "win32" ? DEFAULT_SHELL_BY_PLATFORM.win32 : DEFAULT_SHELL_BY_PLATFORM.other;
export const DEFAULT_SHELL_RUNNER: ShellRunner = "direct";

export function generateShellInit(
  shellType: string = DEFAULT_SHELL,
  runner: ShellRunner = DEFAULT_SHELL_RUNNER,
): string {
  const norm = shellType.toLowerCase().trim();
  const choices = ["bash", "zsh", "fish", "powershell", "pwsh"];
  if (!choices.includes(norm)) {
    throw new WorkspaceError(
      "INVALID_ARGUMENT",
      `Unknown shell '${shellType}'. Choose bash, zsh, fish, powershell, or pwsh.`,
      { shell: shellType, choices, usage: "dev shell-init --help" },
    );
  }
  const posixDev = runner === "mise" ? "mise run dev --" : "command dev";
  const powerShellDev =
    runner === "mise"
      ? "& mise run dev --"
      : "& (Get-Command -CommandType Application dev | Select-Object -First 1)";
  if (norm === "powershell" || norm === "pwsh") {
    return `# dev CLI shell integration for PowerShell
function dev {
    if ($args -contains '--json') {
        ${powerShellDev} @args
        return
    }
    if ($args.Count -ge 1 -and $args[0] -eq 'go') {
        $goArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
        $target = (${powerShellDev} go @goArgs)
        if ($LASTEXITCODE -eq 0 -and $target) {
            Set-Location -LiteralPath $target
        }
    } elseif ($args.Count -ge 2 -and $args[0] -eq 'ws' -and $args[1] -eq 'jump') {
        $target = (${powerShellDev} ws path $args[2])
        if ($LASTEXITCODE -eq 0 -and $target -and (Test-Path -LiteralPath $target -PathType Container)) {
            Set-Location $target
        } else {
            ${powerShellDev} @args
        }
    } else {
        ${powerShellDev} @args
    }
}

function ws {
    if ($args.Count -eq 0) {
        ${powerShellDev} ws
    } elseif ($args.Count -ge 1 -and $args[0] -eq 'jump') {
        $target = (${powerShellDev} ws path $args[1])
        if ($LASTEXITCODE -eq 0 -and $target -and (Test-Path -LiteralPath $target -PathType Container)) {
            Set-Location $target
        } else {
            ${powerShellDev} ws @args
        }
    } elseif ($args.Count -eq 1 -and $args[0] -notin @('init','add','list','status','update','sync','pick','path','remove','duplicate','lock','unlock','tag','track','--help','-h')) {
        $target = (${powerShellDev} ws path $args[0])
        if ($LASTEXITCODE -eq 0 -and $target -and (Test-Path -LiteralPath $target -PathType Container)) {
            Set-Location $target
        } else {
            ${powerShellDev} ws @args
        }
    } else {
        ${powerShellDev} ws @args
    }
}
`;
  }

  if (norm === "fish") {
    return `# dev CLI shell integration for fish
function dev
    if contains -- --json $argv
        ${posixDev} $argv
        return $status
    end
    if test (count $argv) -ge 1; and test "$argv[1]" = "go"
        set -l target (${posixDev} go $argv[2..-1])
        if test $status -eq 0; and test -n "$target"
            cd "$target"
        end
    else if test (count $argv) -ge 2; and test "$argv[1]" = "ws"; and test "$argv[2]" = "jump"
        set -l target (${posixDev} ws path $argv[3])
        if test $status -eq 0; and test -n "$target"; and test -d "$target"
            cd "$target"
        else
            ${posixDev} $argv
        end
    else
        ${posixDev} $argv
    end
end

function ws
    if test (count $argv) -eq 0
        ${posixDev} ws
    else if test "$argv[1]" = "jump"
        set -l target (${posixDev} ws path $argv[2])
        if test $status -eq 0; and test -n "$target"; and test -d "$target"
            cd "$target"
        else
            ${posixDev} ws $argv
        end
    else
        ${posixDev} ws $argv
    end
end
`;
  }

  // The remaining supported shells are bash and zsh.
  return `# dev CLI shell integration for bash/zsh
dev() {
  local arg
  for arg in "$@"; do
    if [ "$arg" = "--json" ]; then
      ${posixDev} "$@"
      return $?
    fi
  done
  if [ "$1" = "go" ]; then
    shift
    local target
    target=$(${posixDev} go "$@")
    if [ $? -eq 0 ] && [ -n "$target" ]; then
      cd "$target" || return 1
    fi
  elif [ "$1" = "ws" ] && [ "$2" = "jump" ]; then
    local target
    target=$(${posixDev} ws path "$3")
    if [ $? -eq 0 ] && [ -n "$target" ] && [ -d "$target" ]; then
      cd "$target" || return 1
    else
      ${posixDev} "$@"
    fi
  else
    ${posixDev} "$@"
  fi
}

ws() {
  if [ $# -eq 0 ]; then
    ${posixDev} ws
  elif [ "$1" = "jump" ]; then
    local target
    target=$(${posixDev} ws path "$2")
    if [ $? -eq 0 ] && [ -n "$target" ] && [ -d "$target" ]; then
      cd "$target" || return 1
    else
      ${posixDev} ws "$@"
    fi
  elif [ $# -eq 1 ] && [ "$1" != "init" ] && [ "$1" != "add" ] && [ "$1" != "list" ] && [ "$1" != "status" ] && [ "$1" != "update" ] && [ "$1" != "sync" ] && [ "$1" != "pick" ] && [ "$1" != "path" ] && [ "$1" != "remove" ] && [ "$1" != "duplicate" ] && [ "$1" != "lock" ] && [ "$1" != "unlock" ] && [ "$1" != "tag" ] && [ "$1" != "track" ] && [ "$1" != "--help" ] && [ "$1" != "-h" ]; then
    local target
    target=$(${posixDev} ws path "$1")
    if [ $? -eq 0 ] && [ -n "$target" ] && [ -d "$target" ]; then
      cd "$target" || return 1
    else
      ${posixDev} ws "$@"
    fi
  else
    ${posixDev} ws "$@"
  fi
}
`;
}
