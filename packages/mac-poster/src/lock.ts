import { mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class LockedError extends Error {}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One instance at a time: the lock file holds the pid (created with O_EXCL). A lock left by a dead process is taken over.
 * Returns the release function.
 */
export function acquireLock(file: string, pid = process.pid, isAlive: (pid: number) => boolean = alive): () => void {
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const other = Number(readFileSync(file, 'utf8').trim());
      if (Number.isInteger(other) && other > 0 && isAlive(other)) throw new LockedError(`уже запущен другой экземпляр (pid ${other}); lock: ${file}`);
      unlinkSync(file); // stale
    }
  }
  throw new LockedError(`не удалось взять lock ${file}`);
}
