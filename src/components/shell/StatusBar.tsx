import { useEffect, useState } from "react";

import { listDrives } from "../../ipc/fs";
import { formatBytes, formatStatus } from "../../lib/format";
import { normalize } from "../../lib/path";
import { useAppStore } from "../../store/appStore";

/**
 * Item counts and free space.
 *
 * Finder puts this at the bottom of every window, and it does a surprising
 * amount of authenticity work for very little code.
 */
export function StatusBar({ visibleCount }: { visibleCount: number }) {
  const cwd = useAppStore((s) => s.cwd);
  const selectedCount = useAppStore((s) => s.selection.size);
  const [free, setFree] = useState<number | null>(null);

  // Free space is per-volume, so it only needs refreshing when the drive
  // changes -- not on every navigation.
  const volume = cwd.length >= 3 ? normalize(cwd.slice(0, 3)) : "";

  useEffect(() => {
    if (volume === "") {
      setFree(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const drives = await listDrives();
        if (cancelled) return;
        const match = drives.find((d) => normalize(d.root) === volume);
        setFree(match && match.ready ? match.freeBytes : null);
      } catch {
        if (!cancelled) setFree(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [volume]);

  return (
    <footer className="fm-status">
      <span>{formatStatus(visibleCount, selectedCount)}</span>
      {free !== null && <span>— {formatBytes(free)} available</span>}
    </footer>
  );
}
