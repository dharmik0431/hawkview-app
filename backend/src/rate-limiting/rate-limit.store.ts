import { Injectable } from '@nestjs/common'
import { FixedWindowCounter } from './fixed-window.js'
import {
  SUBJECT_REQUESTS_PER_WINDOW,
  UNAUTHENTICATED_REQUESTS_PER_WINDOW,
  WINDOW_MS,
  type RateLimitBucket,
} from './rate-limit-policy.js'

/** The counters, in one injectable so the two enforcement points share them.
 *
 * ONE PROVIDER RATHER THAN A COUNTER INSIDE EACH, because a counter held by the
 * interceptor and another held by the middleware would be two limits that each
 * believe they are the limit — and because a single place to hold them is a
 * single place to read their size from when somebody asks what this component is
 * doing to memory.
 *
 * Nest providers are singletons, so these windows live for the life of the
 * process. That is the intended lifetime: a counter reset per request would
 * count nothing.
 */
@Injectable()
export class RateLimitStore {
  private readonly counters: Record<RateLimitBucket, FixedWindowCounter> = {
    SUBJECT: new FixedWindowCounter(SUBJECT_REQUESTS_PER_WINDOW, WINDOW_MS),
    UNAUTHENTICATED: new FixedWindowCounter(UNAUTHENTICATED_REQUESTS_PER_WINDOW, WINDOW_MS),
  }

  counter(bucket: RateLimitBucket): FixedWindowCounter {
    return this.counters[bucket]
  }

  /** What this component is holding, for telemetry. Not per-caller detail: the
   * point is to be able to see that the key caps are adequate without being able
   * to read who has been calling. */
  occupancy() {
    return {
      subjects: this.counters.SUBJECT.size(),
      unauthenticated: this.counters.UNAUTHENTICATED.size(),
      evictionsUnderPressure:
        this.counters.SUBJECT.evictionsUnderPressure() +
        this.counters.UNAUTHENTICATED.evictionsUnderPressure(),
    }
  }
}
