/**
 * Pi's session cwd is on ExtensionContext, not process.cwd(). Stream calls
 * only see SimpleStreamOptions.sessionId, so session_start remembers the
 * mapping for Run-request workspace URIs.
 */
const cwdBySession = new Map<string, string>();
let lastCwd: string | undefined;

export function rememberSessionCwd(sessionId: string | undefined, cwd: string | undefined): void {
  const dir = cwd?.trim();
  if (dir) lastCwd = dir;
  const id = sessionId?.trim();
  if (id && dir) cwdBySession.set(id, dir);
}

export function forgetSessionCwd(sessionId: string | undefined): void {
  const id = sessionId?.trim();
  if (id) cwdBySession.delete(id);
}

export function clearWorkspaceCwds(): void {
  cwdBySession.clear();
  lastCwd = undefined;
}

export function resolveWorkspaceCwd(sessionId?: string): string {
  const id = sessionId?.trim();
  if (id) {
    const remembered = cwdBySession.get(id);
    if (remembered) return remembered;
  }
  return lastCwd || process.cwd();
}
