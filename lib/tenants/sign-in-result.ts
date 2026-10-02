/** Transport labels only. Raw provider codes are validated by the backend. */
export type SignInResult = 'Success' | 'Failure' | 'Not reported'
export function reportedSignInResult(value: unknown): SignInResult {
  return value === 'Success' || value === 'Failure' ? value : 'Not reported'
}
export function signInResultColor(value: unknown): string {
  return value === 'Success' ? '#16a34a' : value === 'Failure' ? '#dc2626' : '#64748b'
}
export function signInResultClass(value: unknown): string {
  return value === 'Success' ? 'bg-green-50 text-green-700 border border-green-200'
    : value === 'Failure' ? 'bg-red-50 text-red-700 border border-red-200'
    : 'bg-slate-50 text-slate-600 border border-slate-200'
}
