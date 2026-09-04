import { useEffect, useRef, useState } from "react";

import { assetUrl, previewPlan, stat } from "../../ipc/fs";
import {
  asFsError,
  type DirEntry,
  type FileMeta,
  type FsError,
  type NoPreviewReason,
  type PreviewPlan,
} from "../../ipc/types";
import { formatBytes, formatDateFull } from "../../lib/format";
import { kindLabel } from "../../lib/kind";
import { basename } from "../../lib/path";
import { FileIcon } from "../common/Icon";

import "./preview.css";

export type PreviewVariant = "pane" | "quicklook" | "column";

/** Long edge to ask the backend to render at, per frame size. */
const MAX_PX: Record<PreviewVariant, number> = {
  pane: 512,
  quicklook: 1600,
  column: 384,
};

const REASON_TEXT: Record<NoPreviewReason, string> = {
  notDownloaded: "This file is stored online and hasn’t been downloaded yet.",
  codecUnsupported: "This video uses a codec this app can’t play.",
  unsupportedFormat: "There’s no preview for this kind of file.",
  tooLarge: "This file is too large to preview.",
  decodeFailed: "This file couldn’t be read.",
  noAccess: "You don’t have permission to read this file.",
};

/**
 * Load the plan for one path.
 *
 * Each request is tagged so a stale response cannot overwrite a newer one --
 * arrowing quickly through Quick Look starts a request per keypress and they do
 * not resolve in order.
 */
function usePreviewPlan(path: string | null, variant: PreviewVariant) {
  const [plan, setPlan] = useState<PreviewPlan | null>(null);
  const [error, setError] = useState<FsError | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!path) {
      setPlan(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    // Keep the previous content visible while the next one loads, rather than
    // flashing an empty frame between every arrow press.
    setError(null);

    void (async () => {
      try {
        const next = await previewPlan(path, MAX_PX[variant]);
        if (requestId.current === id) setPlan(next);
      } catch (e) {
        if (requestId.current === id) {
          setPlan(null);
          setError(asFsError(e));
        }
      }
    })();
  }, [path, variant]);

  return { plan, error };
}

function useMeta(path: string | null) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!path) {
      setMeta(null);
      return;
    }
    const id = ++requestId.current;
    void (async () => {
      try {
        const m = await stat(path);
        if (requestId.current === id) setMeta(m);
      } catch {
        if (requestId.current === id) setMeta(null);
      }
    })();
  }, [path]);

  return meta;
}

function MetadataTable({ meta, entry }: { meta: FileMeta | null; entry?: DirEntry }) {
  if (!meta) return null;
  const rows: Array<[string, string]> = [
    ["Kind", kindLabel(entry ?? meta)],
    ["Size", meta.isDir ? "--" : formatBytes(meta.size)],
    ["Created", formatDateFull(meta.createdMs)],
    ["Modified", formatDateFull(meta.modifiedMs)],
  ];
  if (meta.linkTarget) rows.push(["Target", meta.linkTarget]);
  rows.push(["Where", meta.path]);

  return (
    <table className="fm-pv-meta">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Video and audio need explicit teardown, or playback outlives the preview. */
function useMediaTeardown<T extends HTMLMediaElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (!el) return;
      // Pausing is not enough: WebView2 keeps the decoder alive and memory
      // climbs as you arrow through a folder of videos.
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);
  return ref;
}

function VideoStage({ plan }: { plan: Extract<PreviewPlan, { mode: "video" }> }) {
  const ref = useMediaTeardown<HTMLVideoElement>();
  return (
    <video
      ref={ref}
      // Keyed by path so stepping replaces the element rather than reusing it.
      key={plan.path}
      src={assetUrl(plan.path)}
      poster={plan.poster ? assetUrl(plan.poster) : undefined}
      controls
      preload="metadata"
      autoPlay
      muted
      playsInline
    />
  );
}

function AudioStage({ plan }: { plan: Extract<PreviewPlan, { mode: "audio" }> }) {
  const ref = useMediaTeardown<HTMLAudioElement>();
  return (
    <div className="fm-pv-audio">
      <audio ref={ref} key={plan.path} src={assetUrl(plan.path)} controls preload="metadata" />
    </div>
  );
}

/**
 * The one preview implementation, worn in three frames.
 *
 * `variant` changes only sizing and layout; the content dispatch below is shared
 * so a fix to PDF handling or media teardown lands everywhere at once.
 */
export function PreviewBody({
  path,
  entry,
  variant,
}: {
  path: string | null;
  entry?: DirEntry;
  variant: PreviewVariant;
}) {
  const { plan, error } = usePreviewPlan(path, variant);
  const meta = useMeta(path);
  const showMeta = variant !== "quicklook" || plan?.mode === "none" || plan?.mode === "folder";

  if (!path) {
    return <div className="fm-pv-empty">Select a file to preview it.</div>;
  }

  const name = basename(path);
  const category = entry?.category ?? meta?.category ?? "unknown";

  let stage: React.ReactNode = null;
  if (error) {
    stage = <div className="fm-pv-empty">{error.message}</div>;
  } else if (!plan) {
    stage = <div className="fm-pv-empty">Loading…</div>;
  } else {
    switch (plan.mode) {
      case "image":
        stage = <img key={plan.path} src={assetUrl(plan.path)} alt={name} decoding="async" />;
        break;
      case "imageThumb":
        stage = (
          <img
            key={plan.path}
            src={assetUrl(plan.path)}
            alt={name}
            width={plan.width}
            height={plan.height}
            decoding="async"
          />
        );
        break;
      case "video":
        stage = <VideoStage plan={plan} />;
        break;
      case "audio":
        stage = <AudioStage plan={plan} />;
        break;
      case "pdf":
        // WebView2 ships Edge's PDF viewer, so there is nothing to implement.
        // If this renders blank, the cause is the CSP: object-src and frame-src
        // must both include the asset protocol.
        stage = <embed key={plan.path} type="application/pdf" src={assetUrl(plan.path)} />;
        break;
      case "folder":
        stage = <FileIcon category="folder" size={variant === "quicklook" ? 128 : 96} />;
        break;
      case "text":
        stage = null;
        break;
      case "none":
        stage = <FileIcon category={category} size={variant === "quicklook" ? 128 : 96} />;
        break;
    }
  }

  return (
    <div className={`fm-pv fm-pv--${variant}`}>
      {plan?.mode === "text" ? (
        <>
          <pre className="fm-pv-text">{plan.head.text}</pre>
          {plan.head.truncated && (
            <div className="fm-pv-note">
              Showing the first {formatBytes(plan.head.bytesRead)} of this file.
            </div>
          )}
        </>
      ) : (
        <div className="fm-pv-stage">{stage}</div>
      )}

      {variant !== "quicklook" && <div className="fm-pv-title">{name}</div>}

      {plan?.mode === "none" && <div className="fm-pv-note">{REASON_TEXT[plan.reason]}</div>}
      {plan?.mode === "folder" && (
        <div className="fm-pv-note">
          {plan.childCount === null
            ? "Folder"
            : `${plan.childCount.toLocaleString()} item${plan.childCount === 1 ? "" : "s"}`}
        </div>
      )}

      {showMeta && <MetadataTable meta={meta} entry={entry} />}
    </div>
  );
}
