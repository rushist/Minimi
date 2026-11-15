import type { SVGProps } from 'react';

const paths = {
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  add: <path d="M12 5v14M5 12h14" />,
  up: <path d="M12 19V5m-6 6 6-6 6 6" />,
  stop: (
    <rect
      x="7"
      y="7"
      width="10"
      height="10"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  moon: <path d="M20 15.4A8.8 8.8 0 0 1 8.6 4 8.8 8.8 0 1 0 20 15.4Z" />,
  external: <path d="M7 17 17 7M8 7h9v9" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 4H6a2 2 0 0 0-2 2v10" />
    </>
  ),
  check: <path d="m5 12 5 5L19 7" />,
  thumb: (
    <path d="M8 11l4-7a2 2 0 0 1 2 2v4h4a2 2 0 0 1 2 2l-1.4 6a2 2 0 0 1-2 2H8m0-9H4v9h4z" />
  ),
};

export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
