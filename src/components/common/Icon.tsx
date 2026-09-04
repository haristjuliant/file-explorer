import { memo } from "react";

import type { Category } from "../../ipc/types";

/**
 * Bundled SVG icons, chosen by file-extension category.
 *
 * Deliberately not Windows shell icons: the visual target is Finder, which uses
 * its own icon language, and a Windows blue folder beside Finder-style chrome
 * reads as unfinished. It also means zero Win32 code, no COM apartment, no
 * icon cache, and crisp rendering at every DPI.
 *
 * The known trade-off: every `.exe` in Program Files gets the same glyph. A
 * narrow shell-icon path for `.exe` / `.lnk` / `.ico` can be added later without
 * disturbing anything here.
 */

const FOLDER_FILL = "var(--fm-folder)";

/** A page outline with a folded corner, the base for every document glyph. */
function Page({ accent }: { accent: string }) {
  return (
    <>
      <path
        d="M3.5 1.5h5.3l3.7 3.7v9.3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
        fill="currentColor"
        opacity="0.12"
      />
      <path
        d="M3.5 1.5h5.3l3.7 3.7v9.3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.45"
      />
      <path d="M8.8 1.6v3.6h3.6" fill="none" stroke="currentColor" strokeOpacity="0.45" />
      <g fill={accent}>
        <rect x="4.6" y="9.6" width="6.8" height="1.1" rx="0.55" />
        <rect x="4.6" y="11.8" width="4.6" height="1.1" rx="0.55" />
      </g>
    </>
  );
}

function CategoryGlyph({ category }: { category: Category }) {
  switch (category) {
    case "folder":
      return (
        <>
          <path
            d="M1.5 4.2a1 1 0 0 1 1-1h3.3l1.4 1.5h6.3a1 1 0 0 1 1 1v7.1a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.2Z"
            fill={FOLDER_FILL}
          />
          <path
            d="M1.5 6.2h13v6.6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6.2Z"
            fill={FOLDER_FILL}
            opacity="0.72"
          />
        </>
      );

    case "volume":
    case "disk":
      return (
        <>
          <rect
            x="1.5"
            y="3.5"
            width="13"
            height="9"
            rx="1.6"
            fill="currentColor"
            opacity="0.14"
          />
          <rect
            x="1.5"
            y="3.5"
            width="13"
            height="9"
            rx="1.6"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
          />
          <circle cx="11.6" cy="8" r="1.1" fill="var(--fm-accent)" />
        </>
      );

    case "image":
      return (
        <>
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.4"
            fill="currentColor"
            opacity="0.12"
          />
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.4"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
          />
          <circle cx="5.4" cy="6.1" r="1.3" fill="var(--fm-warning)" />
          <path d="M2.6 12.2 6.6 8l2.5 2.6L11 8.9l2.4 3.3H2.6Z" fill="#34c759" />
        </>
      );

    case "video":
      return (
        <>
          <rect
            x="1.5"
            y="3.2"
            width="13"
            height="9.6"
            rx="1.4"
            fill="currentColor"
            opacity="0.14"
          />
          <rect
            x="1.5"
            y="3.2"
            width="13"
            height="9.6"
            rx="1.4"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
          />
          <path d="M6.5 5.9 10.9 8 6.5 10.1V5.9Z" fill="var(--fm-accent)" />
        </>
      );

    case "audio":
      return (
        <>
          <path
            d="M9.6 2.6v8.1a2.1 2.1 0 1 1-1.3-1.95V4.3l-3.4.8v5.6a2.1 2.1 0 1 1-1.3-1.95V4.1l6-1.5Z"
            fill="var(--fm-accent)"
          />
        </>
      );

    case "pdf":
      return (
        <>
          <Page accent="var(--fm-danger)" />
          <text
            x="8"
            y="8.6"
            textAnchor="middle"
            fontSize="4.2"
            fontWeight="700"
            fill="var(--fm-danger)"
          >
            PDF
          </text>
        </>
      );

    case "code":
      return (
        <>
          <Page accent="transparent" />
          <path
            d="M6.3 8.2 4.9 9.6l1.4 1.4M9.7 8.2l1.4 1.4-1.4 1.4"
            fill="none"
            stroke="var(--fm-accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );

    case "archive":
      return (
        <>
          <path
            d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9Z"
            fill="currentColor"
            opacity="0.14"
          />
          <path
            d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9Z"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
          />
          <path
            d="M8 2.5v3.4M8 7.2v1.4"
            stroke="var(--fm-warning)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <rect x="6.9" y="9.4" width="2.2" height="2.8" rx="0.7" fill="var(--fm-warning)" />
        </>
      );

    case "spreadsheet":
      return (
        <>
          <Page accent="transparent" />
          <g stroke="#34c759" strokeWidth="1" opacity="0.9">
            <path d="M4.4 9.3h7.2M4.4 11.4h7.2M6.8 8.2v4.6M9.2 8.2v4.6" />
          </g>
        </>
      );

    case "presentation":
      return (
        <>
          <Page accent="transparent" />
          <rect x="4.5" y="8.6" width="7" height="4.2" rx="0.6" fill="var(--fm-warning)" />
        </>
      );

    case "document":
      return <Page accent="var(--fm-accent)" />;

    case "text":
      return <Page accent="var(--fm-text-tertiary)" />;

    case "font":
      return (
        <>
          <Page accent="transparent" />
          <text
            x="8"
            y="12.4"
            textAnchor="middle"
            fontSize="7"
            fontWeight="600"
            fill="var(--fm-text-secondary)"
          >
            A
          </text>
        </>
      );

    case "executable":
      return (
        <>
          <rect
            x="2.2"
            y="2.2"
            width="11.6"
            height="11.6"
            rx="2.4"
            fill="var(--fm-accent)"
            opacity="0.16"
          />
          <rect
            x="2.2"
            y="2.2"
            width="11.6"
            height="11.6"
            rx="2.4"
            fill="none"
            stroke="var(--fm-accent)"
            strokeOpacity="0.55"
          />
          <path
            d="M6.4 5.6 10.4 8l-4 2.4V5.6Z"
            fill="var(--fm-accent)"
          />
        </>
      );

    case "package":
      return (
        <>
          <path d="M8 1.9 14 5v6l-6 3.1L2 11V5l6-3.1Z" fill="currentColor" opacity="0.14" />
          <path
            d="M8 1.9 14 5v6l-6 3.1L2 11V5l6-3.1Z"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
          />
          <path d="M2 5l6 3 6-3M8 8v6.1" fill="none" stroke="var(--fm-accent)" strokeOpacity="0.7" />
        </>
      );

    case "shortcut":
      return (
        <>
          <Page accent="transparent" />
          <path
            d="M6.2 11.6 10 7.8M10 7.8H7.4M10 7.8v2.6"
            fill="none"
            stroke="var(--fm-accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );

    default:
      return (
        <>
          <path
            d="M3.5 1.5h5.3l3.7 3.7v9.3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
            fill="currentColor"
            opacity="0.12"
          />
          <path
            d="M3.5 1.5h5.3l3.7 3.7v9.3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
          />
          <path d="M8.8 1.6v3.6h3.6" fill="none" stroke="currentColor" strokeOpacity="0.45" />
        </>
      );
  }
}

export const FileIcon = memo(function FileIcon({
  category,
  size = 16,
}: {
  category: Category;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flex: "none", display: "block" }}
    >
      <CategoryGlyph category={category} />
    </svg>
  );
});

/** UI glyph set: toolbar controls, disclosure triangles, separators. */
export type GlyphName =
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "chevron-tiny-right"
  | "view-list"
  | "view-column"
  | "view-tree"
  | "search"
  | "sidebar-right"
  | "sort-up"
  | "sort-down"
  | "close"
  | "warning";

const GLYPHS: Record<GlyphName, React.ReactNode> = {
  "chevron-left": <path d="M9.6 3.6 5.2 8l4.4 4.4" />,
  "chevron-right": <path d="M6.4 3.6 10.8 8l-4.4 4.4" />,
  "chevron-down": <path d="M3.6 6.4 8 10.8l4.4-4.4" />,
  "chevron-tiny-right": <path d="M6.6 4.8 9.8 8l-3.2 3.2" />,
  "view-list": <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  "view-column": <path d="M5.6 3v10M10.4 3v10M2.5 3h11v10h-11z" />,
  "view-tree": <path d="M2.5 4h11M5.5 8h8M8.5 12h5" />,
  search: <path d="M11.2 11.2 14 14M12.2 7.6a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 0 1 9.2 0Z" />,
  "sidebar-right": <path d="M2.5 3h11v10h-11zM10 3v10" />,
  "sort-up": <path d="M4.8 9.6 8 6.4l3.2 3.2" />,
  "sort-down": <path d="M4.8 6.4 8 9.6l3.2-3.2" />,
  close: <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />,
  warning: <path d="M8 2.8 14 13H2L8 2.8ZM8 6.6v3.1M8 11.2v.9" />,
};

export function Glyph({
  name,
  size = 16,
  strokeWidth = 1.4,
}: {
  name: GlyphName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none", display: "block" }}
    >
      {GLYPHS[name]}
    </svg>
  );
}
