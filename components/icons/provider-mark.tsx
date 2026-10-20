import { productIcons, PRODUCT_ICON_STROKE_WIDTH } from '@/lib/ui/product-icons'
import { cn } from '@/lib/utils'

type Provider = 'microsoft' | 'google'
type Size = 'compact' | 'small' | 'normal'

const dimensions: Record<Size, { frame: string; glyph: string }> = {
  compact: { frame: 'h-7 w-7', glyph: 'h-3.5 w-3.5' },
  small: { frame: 'h-8 w-8', glyph: 'h-4 w-4' },
  normal: { frame: 'h-10 w-10', glyph: 'h-5 w-5' },
}

/** Neutral provider pictograms, independent of vendor logos and trademarks. */
export function ProviderMark({
  provider,
  size = 'small',
  className,
}: {
  provider: Provider
  size?: Size
  className?: string
}) {
  const Icon = provider === 'microsoft' ? productIcons.microsoft365 : productIcons.googleWorkspace
  return (
    <span
      role="img"
      aria-label={provider === 'microsoft' ? 'Microsoft 365' : 'Google Workspace'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg border',
        dimensions[size].frame,
        provider === 'microsoft'
          ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300'
          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
        className
      )}
    >
      <Icon className={dimensions[size].glyph} strokeWidth={PRODUCT_ICON_STROKE_WIDTH} aria-hidden="true" />
    </span>
  )
}
