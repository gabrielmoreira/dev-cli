export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<ShellExecResult> {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

export interface RunHookEnv {
  DEV_ROOT?: string;
  DEV_WORKSPACE?: string;
  DEV_MOUNT_PATH?: string;
  DEV_SOURCE?: string;
  DEV_REVISION?: string;
  [key: string]: string | undefined;
}

export interface RunHookOptions {
  cwd?: string;
  env?: RunHookEnv;
}

export async function runHook(
  command: string,
  options: RunHookOptions = {},
): Promise<ShellExecResult> {
  const isWin = process.platform === "win32";
  const shellArgs = isWin ? ["cmd.exe", "/c", command] : ["sh", "-c", command];

  return runCommand(shellArgs[0], shellArgs.slice(1), {
    cwd: options.cwd,
    env: options.env,
  });
}
