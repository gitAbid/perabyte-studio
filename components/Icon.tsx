import type { SVGProps } from "react";

export type IconName =
  | "logo"
  | "home"
  | "sparkle"
  | "image"
  | "video"
  | "history"
  | "user"
  | "arrow-right"
  | "arrow-left"
  | "download"
  | "share"
  | "play"
  | "pause"
  | "volume"
  | "fullscreen"
  | "plus"
  | "trash"
  | "copy"
  | "heart"
  | "more"
  | "check"
  | "clock"
  | "alert"
  | "close"
  | "chevron-down"
  | "layers"
  | "grid"
  | "search"
  | "menu"
  | "star"
  | "story"
  | "character"
  | "lock"
  | "refresh"
  | "upload"
  | "sliders"
  | "chip"
  | "eye";

const PATHS: Record<IconName, string> = {
  logo: "M4 15.5V8.5l6-4.2 6 4.2v7l-6 4.2-6-4.2Z M16 6.5l4 2.8v6.4l-4 2.8",
  home: "M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5",
  sparkle:
    "M12 3l1.6 4.7L18.3 9.3l-4.7 1.6L12 15.6l-1.6-4.7L5.7 9.3l4.7-1.6L12 3Zm6.5 9.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z",
  image:
    "M3.5 5.5A1.5 1.5 0 0 1 5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-13Zm3 8.5 3-3.2 3.2 3.4 2.3-2.2 3.5 3.5M9 9.5h.01",
  video: "M3.5 6.5A1.5 1.5 0 0 1 5 5h9a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 14 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Zm11 4.2 5-3v8.6l-5-3v-2.6Z",
  history:
    "M12 7v5l3 2M4.6 9.5A8 8 0 1 1 4 12m.6-2.5H8M4.6 9.5V6",
  user: "M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.5 8a7.5 7.5 0 0 1 15 0",
  "arrow-right": "M4 12h15m-6-6 6 6-6 6",
  "arrow-left": "M20 12H5m6-6-6 6 6 6",
  download: "M12 4v11m0 0 4-4m-4 4-4-4M4.5 19.5h15",
  share: "M15 5.5 9 9m6 9.5L9 15M6.5 13.8a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Zm11 -6.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Zm0 11a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  pause: "M9 5.5v13M15 5.5v13",
  volume: "M5 9.5h3l4-3.5v12l-4-3.5H5v-5Zm11-1a5 5 0 0 1 0 7",
  fullscreen: "M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5",
  plus: "M12 5v14M5 12h14",
  trash: "M4.5 7h15M9 7V5.5h6V7m-8 0 .8 12.2a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7",
  copy: "M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8A1.5 1.5 0 0 1 13.5 20h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9Z",
  heart: "M12 19.5S4.5 15 4.5 10.2A3.7 3.7 0 0 1 12 8.2a3.7 3.7 0 0 1 7.5 2c0 4.8-7.5 9.3-7.5 9.3Z",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  check: "M5 12.5 10 17l9-10",
  clock: "M12 7.5V12l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  alert: "M12 8.5v5m0 3.2h.01M10.3 4.3 3.2 17a2 2 0 0 0 1.7 3h14.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z",
  close: "M6 6l12 12M18 6 6 18",
  "chevron-down": "M6 9.5l6 6 6-6",
  layers: "M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5ZM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5",
  grid: "M4.5 4.5h6v6h-6v-6Zm9 0h6v6h-6v-6Zm-9 9h6v6h-6v-6Zm9 0h6v6h-6v-6Z",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.8-1.7L20 20",
  menu: "M4 7h16M4 12h16M4 17h16",
  star: "M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4-3.9 5.5-.8L12 4Z",
  story: "M5 4.5h9l5 5v10a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19.5v-13A1.5 1.5 0 0 1 5.5 5M14 4.5v5h5M8 13h8M8 16.5h5",
  character:
    "M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12A1.5 1.5 0 0 1 18 19.5H6A1.5 1.5 0 0 1 4.5 18V6ZM12 11.8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM7.4 16.6a4.8 4.8 0 0 1 9.2 0",
  lock: "M7 10.5V8a5 5 0 0 1 10 0v2.5M6 10.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
  refresh: "M20 11a8 8 0 0 0-13.7-4.6L4 8.5M4 13a8 8 0 0 0 13.7 4.6L20 15.5M4 4.5v4h4M20 19.5v-4h-4",
  upload: "M12 16V5m0 0-4 4m4-4 4 4M4.5 19.5h15",
  sliders: "M5 8h9m3 0h2M5 12h3m3 0h8M5 16h9m3 0h2M14 6v4M8 10v4M14 14v4",
  chip: "M9 3.5v2m6-2v2M9 18.5v2m6-2v2M3.5 9h2m-2 6h2m13-6h2m-2 6h2M7.5 7.5h9v9h-9Zm3 3h3v3h-3Z",
  eye: "M3 12s3-5.8 9-5.8S21 12 21 12s-3 5.8-9 5.8S3 12 3 12Zm9-2.6a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z",
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex items-center justify-center rounded-[10px] bg-ink text-white"
        style={{ width: size, height: size }}
      >
        <svg
          width={size * 0.62}
          height={size * 0.62}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 15.5V9l5.5-3.6L16 9v6.5L10.5 19 5 15.5Z" />
          <path d="M16 7.4l3 1.9v5.2l-3 1.9" opacity="0.65" />
        </svg>
      </span>
      <span className="text-[15px] font-bold tracking-tight text-ink">
        PeraByte
      </span>
    </span>
  );
}