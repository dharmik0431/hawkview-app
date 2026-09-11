# API rate limiting

## What was missing

Nothing limited how often anyone could call the API. No `@nestjs/throttler`, no
`express-rate-limit`, no per-address or per-account limit on any route — not
installed, not configured, nothing hand-rolled. One client in a retry loop, or
one leaked token, could issue requests as fast as the network allowed.

`src/workspace/invitation-rate-limit.test.ts` is not a counter-example. It covers
HawkView *absorbing* a 429 **from Auth0** without corrupting local state. It
limits nothing inbound.

## What is here now

Two limits, one policy, one store.

| Bucket | Keyed on | Limit | Status |
|---|---|---|---|
| `SUBJECT` | the verified authenticated subject | 600 requests / 60s | **active** |
| `UNAUTHENTICATED` | the client address | 120 requests / 60s | **inert** — see below |

Both are fixed-window, in memory, in `src/rate-limiting/`. The decision lives in
one pure function, `planFor` in `rate-limit-policy.ts`; the two enforcement
points (an interceptor for the subject limit, middleware for the address limit)
consult it rather than repeating it.

### Why 600 a minute per subject

Derived from measured use, not chosen for roundness. One tenant page issues about
six requests, and an operator moving briskly through tenants was measured at
roughly sixty requests a minute. 600 is an order of magnitude above that.

That headroom is the point. A limit within the same order of magnitude as real
work will eventually interrupt real work, and the cost of interrupting an MSP
mid-investigation is much higher than the cost of letting an abusive caller send
600 requests instead of 200. It still bounds what one compromised token or one
looping client can spend.

### Why the subject and not the address

An MSP office sits behind one NAT. Keyed on the address, a busy afternoon in a
ten-person office is indistinguishable from one abusive caller, and the ten
people are refused together. The subject comes from a verified token, survives a
caller changing networks, and separates colleagues who share an address.

## The exemptions, and why each one is there

Both are answered **before** any configuration, key or counter is consulted —
`planFor` returns on them in its first branch. That ordering is the guarantee. As
a later `if`, or as a very large limit, the property would hold today and quietly
stop holding the first time someone reordered the function or lowered a number.

### `/api/internal/sync` — the scheduler

`POST /api/internal/sync/due-tenants` is the product's heartbeat. It arrives once
every five minutes and it is what causes HawkView to collect anything at all.

A limiter that refuses it shows an error to nobody. Collection simply stops, the
data goes stale, and every screen keeps confidently displaying the last thing it
knew. There is no red banner and no failed request in any customer's browser —
the failure looks exactly like a quiet week.

The **whole prefix** is exempt rather than the single known path, so that the
next internal sync route added inherits the exemption instead of inheriting an
outage nobody can see.

The accepted trade-off: that route is unmetered. Its protection is its token —
Google OIDC, or a shared secret of at least 32 characters — and the fact that the
work it triggers is already bounded inside the process. `runScheduledGlobalRiskCycle`
and `syncDueTenants` run inside the sync memory lane, so a second concurrent
heartbeat defers rather than multiplying the load, and the controller holds its
own admission deadlines (10s maintenance, 15s history, 45s risk cycle, 240s
overall). An unmetered call to it cannot buy an attacker more work than one cycle.

### `/health` — liveness and readiness

Refusing a probe does not throttle anyone. It tells the platform the service is
unhealthy and takes it out of rotation, turning a rate limit into the outage it
was meant to prevent.

Prefix matching is exact about boundaries: `/health` and `/health/database` are
exempt, `/healthcheck-admin` is not.

## What to check first if collection stops

This component's failure mode is silent, so it should be ruled in or out **first**
and quickly, not reasoned about.

**1. Take it out of the picture.** Set `HAWKVIEW_RATE_LIMIT_ENFORCE=false` and
restart the service. This disables every limit, immediately, without a deploy or
a code change.

- If collection resumes, the limiter was the cause. Go to step 3.
- **If collection does not resume, the limiter was not the cause.** Stop looking
  here and go to step 4. This is the more likely outcome.

**2. Read the logs.** Every refusal logs one line:

```
{"event":"rate_limit_refused","bucket":"...","path":"...","count":N,"limit":N}
```

If no such line names a path under `/api/internal/sync`, this component never
refused the heartbeat. (It cannot: see step 3 for the only way that changes.)

**3. The one way this component can stop collection.** The exemption is keyed on
the path prefix `/api/internal/sync`. If the scheduler route is ever renamed, or
moved out from under that prefix, **the exemption does not follow it** and the
heartbeat becomes ordinary traffic. Check that `ScheduledSyncController`'s
`@Controller` prefix still matches `SCHEDULER_PATH_PREFIX` in
`src/rate-limiting/rate-limit-policy.ts`. `rate-limit-policy.test.ts` and
`rate-limit.interceptor.test.ts` both assert the current path is never refused,
so a rename that breaks this should fail CI before it reaches anyone — but a
rename plus a test updated to match would not.

**4. More likely causes, in the order worth checking.** Scheduler token
configuration (`SCHEDULER_SHARED_SECRET`, `SCHEDULER_OIDC_AUDIENCE`,
`SCHEDULER_SERVICE_ACCOUNT_EMAIL`) — a misconfigured verifier refuses the
heartbeat with a 401 and stops collection in exactly the same silent way. Then
the scheduler itself (is it still invoking us?), then the sync memory lane, then
the collectors.

## The address-keyed limit is inert, deliberately

`UNAUTHENTICATED` does not enforce anything until
`HAWKVIEW_TRUSTED_PROXY_HOPS` is set. Shipped that way on purpose.

Nothing in this backend configures Express to trust a proxy — `main.ts` calls
`NestFactory.create` and never sets `trust proxy`, and there is no other place a
client address is derived. So `request.socket.remoteAddress` is the platform's
edge, **identical for every request the service receives**.

An address-keyed limiter built on that value does not limit callers. It puts
every customer of every MSP, plus the whole internet, into one bucket, and turns
"120 requests a minute per address" into "120 requests a minute, total, for
everybody". Every unit test still passes, because a synthetic request carries its
own distinct address.

Reading `X-Forwarded-For` instead is not free either: a client may send its own,
and a proxy appends rather than replaces, so the leftmost entries are
caller-controlled. Keying on those lets an attacker mint a fresh allowance per
request by varying a header — the same forgery `RequestCorrelationMiddleware`
already refuses for audit identifiers.

What makes the header readable is knowing how many trailing entries our own
infrastructure appended. That is a property of the deployment, so it has to be
stated by whoever operates the deployment.

### Activating it

1. Determine the hop count. Send a request from a known address and log the full
   `X-Forwarded-For` the service received. Count the entries appended after your
   address. One edge proxy in front of the service means `1`.
2. Set `HAWKVIEW_TRUSTED_PROXY_HOPS` to that number and restart.
3. Confirm: two callers on different networks should land in different buckets.
   If the limit starts refusing traffic globally rather than per caller, the
   number is wrong — unset it and the limiter goes inert again.

`clientAddress` counts from the right and returns `null` whenever the header is
too short, unparseable, or the hop count is unstated. `null` never becomes a
shared key; it disables the limit for that request instead.

## What this does not cover

**A flood of well-formed but invalid bearer tokens.** The middleware skips any
request carrying a syntactically valid `Bearer` token, because metering those by
address would mean metering *authenticated* traffic by address before the subject
is known — the NAT problem above. Such a request is then rejected by
`IdentityAuthGuard` before any interceptor runs, so it is counted nowhere.

Closing this means counting verification **failures** per address, which is
blocked on the same prerequisite: without a trustworthy client address, every
failure in the world keys into one bucket. Do this after
`HAWKVIEW_TRUSTED_PROXY_HOPS` is set and confirmed.

**Brute force against a password.** Not applicable here, and worth recording so
nobody adds a limit for it. This API has no login endpoint. `/auth/bootstrap` and
`/auth/profile` are both already-authenticated routes; credentials are verified
by the identity provider and reach HawkView only as a signed bearer token. The
credential that *is* brute-forceable at this layer is the scheduler token, and it
is deliberately unmetered for the availability reason given above.

## Operating notes

- **Per instance, not per service.** The counters are in memory, so with N
  instances the effective ceiling is N times the configured number. This is a
  deliberate trade against adding Redis: a limiter whose store is unreachable
  either refuses everything (a worse outage than the abuse) or allows everything
  (no limiter at all). Read the numbers as an order of magnitude, not a quota.
- **Fixed window.** A caller can spend its allowance at the end of one window and
  again at the start of the next, so the true worst case is twice the limit
  across a window's span. Acceptable for bounding abuse; it would not be
  acceptable for billing.
- **Memory is bounded.** 20,000 keys per bucket. Expired windows are reclaimed
  first; if the cap is reached with everything still live, the soonest-to-expire
  key is dropped and `RateLimitStore.occupancy().evictionsUnderPressure`
  increments. That forgives one caller's count rather than refusing a caller who
  has done nothing — the limiter degrades instead of the product. A non-zero
  count means the cap is too low for this deployment.
- **Refusals carry `Retry-After`**, never below 1 second, and keep their
  `X-Request-ID` because request correlation middleware runs first.
- **Logs carry the bucket, path, count and limit — never the key.** Which person
  it was is not needed to tell a runaway client from a limit set too low, and a
  user identifier in a log line is a durable copy of it somewhere with different
  access rules.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `HAWKVIEW_RATE_LIMIT_ENFORCE` | enforcing | Exactly `false` disables every limit. A typo or `0` does not — switching this off should have to be spelled out. |
| `HAWKVIEW_TRUSTED_PROXY_HOPS` | unset | Number of proxies in front of the service that may be believed about the caller's address. Unset keeps the address-keyed limit inert. |

Both are read per request rather than captured at construction, so either can be
changed with a restart and no deploy.
