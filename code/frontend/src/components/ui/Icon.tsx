import type { SVGProps } from 'react'

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  print: 'M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z',
  documents: 'M8 3h6l4 4v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14 3v4h4M9 12h6M9 16h6',
  orders: 'M4 6h16M4 12h16M4 18h10',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c1.5-4 5-6 8-6s6.5 2 8 6',
  upload: 'M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3',
  download: 'M12 4v12m0 0 4.5-4.5M12 16 7.5 11.5M5 18v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6',
  check: 'm5 13 4 4 10-10',
  checkCircle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-3-9.5 2.2 2.2L16 10',
  x: 'M6 6l12 12M18 6 6 18',
  xCircle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9 9l6 6M15 9l-6 6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-15v5l3.5 2',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.6 17a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a1.6 1.6 0 0 0-2.8 0Z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v5m0-8h.01',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  chevronDown: 'm6 9 6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  arrowRight: 'M4 12h16m0 0-6-6m6 6-6 6',
  refresh: 'M4 4v5h5M20 20v-5h-5M4.5 9a8 8 0 0 1 14-4.2L20 7M19.5 15a8 8 0 0 1-14 4.2L4 17',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  bell: 'M12 3a5 5 0 0 0-5 5v3.2c0 .6-.2 1.1-.6 1.5L5 14.5V16h14v-1.5l-1.4-1.8a2.3 2.3 0 0 1-.6-1.5V8a5 5 0 0 0-5-5ZM9.5 19a2.5 2.5 0 0 0 5 0',
  shop: 'M4 10v10h16V10M2 10l2-6h16l2 6M2 10h20M8 20v-6h8v6',
  bindings: 'M8 3v18M4 6h4M4 10h4M4 14h4M4 18h4M12 3h8v18h-8z',
  filter: 'M4 6h16M7 12h10M10 18h4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  building: 'M4 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M12 21v-9a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v9M8 9h.01M8 13h.01M4 21h16',
  gift: 'M4 10h16v3H4zM6 10V8a2 2 0 0 1 2-2h1.5c1 0 1.8-1.2 1-2.2C9.7 3 8.5 3 8 4l4 4 4-4c-.5-1-1.7-1-2.5-.2-.8 1-.2 2.2 1 2.2H16a2 2 0 0 1 2 2v2M6 13v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM7 7h.01M17 7h.01M7 17h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.3 6.9A16.8 16.8 0 0 0 2 12s3.5 7 10 7c1.4 0 2.6-.2 3.7-.6',
} as const

export type IconName = keyof typeof PATHS

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 20, strokeWidth = 1.8, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
