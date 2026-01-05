import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorStateProps {
  message?: string
  onRetry?: () => void
}

export function ErrorState({
  message = 'Something went wrong',
  onRetry,
}: ErrorStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16"
      role="alert"
      aria-live="assertive"
    >
      <AlertCircle className="h-12 w-12 text-destructive" aria-hidden="true" />
      <p className="mt-4 text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="outline" className="mt-4">
          Try again
        </Button>
      )}
    </div>
  )
}
