import Image from 'next/image'
import { cn } from '@/lib/utils'

type HawkViewBrandProps = {
  compact?: boolean
  className?: string
  markClassName?: string
  wordmarkClassName?: string
}

export function HawkViewBrand({
  compact = false,
  className,
  markClassName,
  wordmarkClassName,
}: HawkViewBrandProps) {
  return (
    <span
      className={cn('inline-flex items-center gap-2.5', className)}
      aria-label={compact ? 'HawkView' : undefined}
    >
      <Image
        src="/brand/hawkview-favicon.svg"
        width={40}
        height={40}
        priority
        alt=""
        aria-hidden="true"
        className={cn('h-10 w-10 shrink-0', markClassName)}
      />
      {!compact && (
        <span className={cn('whitespace-nowrap font-bold tracking-tight', wordmarkClassName)}>
          HawkView
        </span>
      )}
    </span>
  )
}
