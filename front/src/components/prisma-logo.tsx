import { cn } from "@/lib/utils"

/** Marca do Prisma: um triângulo que decompõe a luz em espectro. */
export function PrismaLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8", className)}>
      <defs>
        <linearGradient id="prisma-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--chart-1)" />
          <stop offset="0.55" stopColor="var(--chart-2)" />
          <stop offset="1" stopColor="var(--chart-3)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#prisma-face)" />
      <path d="M16 6.5 25.5 24h-19L16 6.5Z" fill="none" stroke="white" strokeWidth="2" strokeLinejoin="round" />
      <path d="M16 6.5 13 24" stroke="white" strokeOpacity="0.55" strokeWidth="1.5" />
    </svg>
  )
}
