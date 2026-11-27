import type { ReactNode } from 'react'

// Small shared icons, and the "where it runs" chip used on every screen:
//   grey laptop chip = stays on this laptop      solid teal cloud chip = goes to the cloud
// Where a step runs is the point of this app, so the same two chips mean the same thing everywhere.

const SVG = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

interface IconProps {
  size?: number
}

export function LaptopIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
    </svg>
  )
}

export function CloudIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  )
}

export function LockIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export function ChevronIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function PencilIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M17 3l4 4L8 20l-5 1 1-5L17 3z" />
    </svg>
  )
}

export function ScanIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
    </svg>
  )
}

export function AccessIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <circle cx="12" cy="4.5" r="1.6" />
      <path d="M5 8.5c4.5 1.4 9.5 1.4 14 0M12 9.5v4.5M9 21l3-7 3 7" />
    </svg>
  )
}

export function ArrowLeftIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M19 12H5m6-6-6 6 6 6" />
    </svg>
  )
}

export function TrashIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 7h16M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7m3 0-.8 12a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9L6 7" />
    </svg>
  )
}

export function DownloadIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" />
    </svg>
  )
}

export function SpeakerIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  )
}

export function StopIcon({ size = 18 }: IconProps) {
  return (
    <svg {...SVG} width={size} height={size}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

export function WhereChip({ where, children }: { where: 'laptop' | 'cloud'; children: ReactNode }) {
  return (
    <span className={where === 'cloud' ? 'where is-cloud' : 'where'}>
      {where === 'cloud' ? <CloudIcon /> : <LaptopIcon />}
      {children}
    </span>
  )
}
