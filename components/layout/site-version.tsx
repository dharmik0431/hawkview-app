import { FRONTEND_BUILD_IDENTITY } from '@/lib/config/frontend-build-identity'

/** Identity compiled into this frontend; independent of authentication and API state. */
export function SiteVersion({ align = 'start', placement = 'bottom' }: { align?: 'start' | 'center'; placement?: 'top' | 'bottom' }) {
  const identity = FRONTEND_BUILD_IDENTITY
  if (identity.kind !== 'build') {
    return (
      <span className="text-[11px] leading-5 text-slate-600 dark:text-slate-400" aria-label="Frontend site version">
        {identity.kind === 'development' ? 'Development' : 'Version unavailable'}
      </span>
    )
  }

  return (
    <details className="relative inline-block max-w-full text-left text-[11px] leading-5 text-slate-600 dark:text-slate-400">
      <summary className="cursor-pointer whitespace-nowrap rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label={`Frontend site version ${identity.sourceHash.slice(0, 12)}; show build details`}>
        Version <span className="font-mono">{identity.sourceHash.slice(0, 12)}</span>
      </summary>
      <div className={`absolute z-50 w-64 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 ${placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} ${align === 'center' ? 'left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2' : 'left-0 max-w-[calc(100vw-7rem)]'}`}>
        <p className="font-semibold">Frontend build details</p>
        <dl className="mt-2 space-y-2 select-text">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Source fingerprint</dt>
            <dd className="break-all font-mono">{identity.sourceHash}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Built (UTC)</dt>
            <dd><time dateTime={identity.builtAt}>{identity.builtAt.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')}</time></dd>
          </div>
        </dl>
        <p className="mt-2 text-slate-500 dark:text-slate-400">Identifies this frontend’s source build; runtime settings are separate.</p>
      </div>
    </details>
  )
}
