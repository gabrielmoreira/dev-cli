import { resolveWorkspacePath } from "./ws.ts";

export interface ResolveJumpTargetInput {
  root: string;
  workspaceName?: string;
  cwd?: string;
}

export interface JumpTarget {
  name: string;
  path: string;
}

export function resolveJumpTarget(input: ResolveJumpTargetInput): JumpTarget {
  const wsPath = resolveWorkspacePath({
    root: input.root,
    workspaceName: input.workspaceName,
    cwd: input.cwd,
  });
  const segments = wsPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = input.workspaceName || segments[segments.length - 1] || "workspace";
  return {
    name,
    path: wsPath,
  };
}

export type ShellRunner = "direct" | "mise";

export function generateShellInit(shellType: string, runner: ShellRunner = "direct"): string {
  const norm = (shellType || "bash").toLowerCase().trim();
  const posixDev = runner === "mise" ? "mise run dev --" : "command dev";
  const powerShellDev =
    runner === "mise" ? "& mise run dev --" : "& (Get-Command -CommandType Application dev)";
  if (norm === "powershell" || norm === "pwsh") {
    return `# dev CLI shell integration for PowerShell
function dev {
    if ($args.Count -ge 1 -and $args[0] -eq 'go') {
        $goArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
        $target = (${powerShellDev} go --candidates @goArgs | fzf --select-1 --exit-0)
        if ($LASTEXITCODE -eq 0 -and $target) {
            Set-Location -LiteralPath $target
        }
    } elseif ($args.Count -ge 2 -and $args[0] -eq 'ws' -and $args[1] -eq 'jump') {
        $target = (${powerShellDev} ws path $args[2])
        if ($LASTEXITCODE -eq 0 -and $target) {
            Set-Location $target
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
        if ($LASTEXITCODE -eq 0 -and $target) {
            Set-Location $target
        }
    } elseif ($args.Count -eq 1 -and $args[0] -notin @('init','add','list','status','update','sync','pick','path','up','remove','duplicate','lock','unlock','tag','track','--help','-h')) {
        $target = (${powerShellDev} ws path $args[0])
        if ($LASTEXITCODE -eq 0 -and $target) {
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
    if test (count $argv) -ge 1; and test "$argv[1]" = "go"
        set -l target (${posixDev} go --candidates $argv[2..-1] | fzf --select-1 --exit-0)
        if test $status -eq 0; and test -n "$target"
            cd "$target"
        end
    else if test (count $argv) -ge 2; and test "$argv[1]" = "ws"; and test "$argv[2]" = "jump"
        set -l target (${posixDev} ws path $argv[3])
        if test $status -eq 0; and test -n "$target"
            cd "$target"
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
        if test $status -eq 0; and test -n "$target"
            cd "$target"
        end
    else
        ${posixDev} ws $argv
    end
end
`;
  }

  // Default: bash and zsh
  return `# dev CLI shell integration for bash/zsh
dev() {
  if [ "$1" = "go" ]; then
    shift
    local target
    target=$(${posixDev} go --candidates "$@" | fzf --select-1 --exit-0)
    if [ $? -eq 0 ] && [ -n "$target" ]; then
      cd "$target" || return 1
    fi
  elif [ "$1" = "ws" ] && [ "$2" = "jump" ]; then
    local target
    target=$(${posixDev} ws path "$3")
    if [ $? -eq 0 ] && [ -n "$target" ]; then
      cd "$target" || return 1
    else
      echo "Failed to resolve workspace path" >&2
      return 1
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
    if [ $? -eq 0 ] && [ -n "$target" ]; then
      cd "$target" || return 1
    fi
  elif [ $# -eq 1 ] && [ "$1" != "init" ] && [ "$1" != "add" ] && [ "$1" != "list" ] && [ "$1" != "status" ] && [ "$1" != "update" ] && [ "$1" != "sync" ] && [ "$1" != "pick" ] && [ "$1" != "path" ] && [ "$1" != "up" ] && [ "$1" != "remove" ] && [ "$1" != "duplicate" ] && [ "$1" != "lock" ] && [ "$1" != "unlock" ] && [ "$1" != "tag" ] && [ "$1" != "track" ] && [ "$1" != "--help" ] && [ "$1" != "-h" ]; then
    local target
    target=$(${posixDev} ws path "$1")
    if [ $? -eq 0 ] && [ -n "$target" ]; then
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
