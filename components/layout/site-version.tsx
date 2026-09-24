import { FRONTEND_RELEASE } from '@/lib/config/frontend-release'

/** The tracked release number, independent of authentication and API state. */
export function SiteVersion(_props: { align?: 'start' | 'center'; placement?: 'top' | 'bottom' }) {
  const version = FRONTEND_RELEASE.label === 'Unavailable' ? 'unavailable' : FRONTEND_RELEASE.label
  return (
    <span className="text-[11px] leading-5 text-slate-600 dark:text-slate-400" aria-label="Frontend site version">
      Version {version}
    </span>
  )
}
