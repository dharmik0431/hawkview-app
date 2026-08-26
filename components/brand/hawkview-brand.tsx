import Image from 'next/image'
import { cn } from '@/lib/utils'

type HawkViewBrandProps = {
  compact?: boolean
  appearance?: 'light' | 'dark' | 'adaptive'
  className?: string
  markClassName?: string
  wordmarkClassName?: string
}

export function HawkViewBrand({
  compact = false,
  appearance = 'adaptive',
  className,
  markClassName,
  wordmarkClassName,
}: HawkViewBrandProps) {
  const sharedMarkClassName = cn('h-10 w-10 shrink-0 object-contain', markClassName)

  return (
    <span
      className={cn('inline-flex items-center gap-2.5', className)}
      aria-label={compact ? 'HawkView' : undefined}
    >
      {appearance === 'adaptive' ? (
        <>
          <Image
            src="/brand/hawkview-mark.svg"
            width={40}
            height={40}
            priority
            alt=""
            aria-hidden="true"
            className={cn(sharedMarkClassName, 'dark:hidden')}
          />
          <Image
            src="/brand/hawkview-mark-on-dark.svg"
            width={40}
            height={40}
            priority
            alt=""
            aria-hidden="true"
            className={cn(sharedMarkClassName, 'hidden dark:block')}
          />
        </>
      ) : (
        <Image
          src={
            appearance === 'dark'
              ? '/brand/hawkview-mark-on-dark.svg'
              : '/brand/hawkview-mark.svg'
          }
          width={40}
          height={40}
          priority
          alt=""
          aria-hidden="true"
          className={sharedMarkClassName}
        />
      )}
      {!compact && (
        <span className={cn('whitespace-nowrap font-bold tracking-tight', wordmarkClassName)}>
          HawkView
        </span>
      )}
    </span>
  )
}
