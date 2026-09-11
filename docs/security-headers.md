# Security headers

## What was missing

The API set no security response headers at all. It also advertised itself via
Express's default `X-Powered-By`.

## What is here now

`helmet` in `main.ts`, applied before CORS and after request correlation, so a
response still carries its `X-Request-ID`.

Measured on a real response from the assembled app:

```
strict-transport-security: max-age=63072000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: no-referrer
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
origin-agent-cluster: ?1
x-dns-prefetch-control: off
x-download-options: noopen
x-permitted-cross-domain-policies: none
x-xss-protection: 0
```

`x-powered-by` is gone. `content-security-policy` is deliberately absent.

helmet was chosen over hand-written headers because it adds **one** package with
**no transitive dependencies** — 14 lockfile lines — and it is the thing a
reviewer recognises.

### HSTS is the one that matters

The API is served on a custom domain, so `Strict-Transport-Security` is what stops
a browser ever attempting `api.hawkviewapp.com` over plaintext. That matters here
specifically because every authenticated request carries a bearer token: a single
downgraded request is a leaked credential, and HSTS removes the attempt rather
than protecting it.

Two years, `includeSubDomains`, and **not** `preload`:

- `includeSubDomains` is safe because the API is itself a subdomain; the header
  applies to that host and anything beneath it, not to the parent domain. It
  would need thought if this were ever served from the apex, because it would
  then force HTTPS on *every* sibling subdomain.
- `preload` is omitted on purpose. Submitting to the browser preload list is
  effectively permanent and removal takes months. That is an owner's decision,
  not something a deploy should quietly make.

### No Content-Security-Policy, deliberately

This service returns JSON and exactly one 303 redirect. It renders no markup, so
CSP directives here would constrain nothing that exists. Shipping a policy that
describes no resources is a security claim nobody can check, and a later reader
would reasonably trust it.

If a route is ever added that returns HTML, that is the moment to add a real CSP
written against what that page actually loads.

## What to check first when it breaks

**The failure mode is HSTS, and it is sticky.** A browser that has seen the header
once will refuse plaintext to that host for two years, and it will not ask.

**Symptom: a browser cannot reach the API over `http://` and shows a certificate
or connection error you cannot click through.**

1. Confirm it is HSTS, not the server. `curl` is unaffected — HSTS is a browser
   policy, so `curl -v http://<host>/health` still behaves normally. If curl works
   and browsers do not, it is HSTS.
2. Check the host. HSTS from `api.hawkviewapp.com` applies to that host and its
   subdomains. It does **not** apply to `localhost`, so local development is
   untouched.
3. To clear it for one browser: Chrome's `chrome://net-internals/#hsts` has a
   "Delete domain security policies" field. This is per-browser and per-machine —
   fine for a developer, not a fix for users.
4. To clear it properly you must serve `Strict-Transport-Security: max-age=0` from
   that host over HTTPS and wait for each client to see it. There is no way to
   recall it faster. This is why `preload` is off: preloading puts the policy in
   the browser binary, where even that remedy does not reach.

**Symptom: a browser console reports a blocked resource or a CSP violation.**
Not from here — no CSP is set. Look at the frontend's own headers.

**Symptom: cross-origin requests from the frontend start failing.** Check CORS in
`main.ts` (`FRONTEND_ORIGINS`) first. `cross-origin-resource-policy: same-origin`
governs *no-cors subresource embedding*, not `fetch` under CORS, so it does not
affect the frontend's API calls — but it would block another origin from embedding
an API response as an image or script, which nothing does.

## Removing it

`helmet()` is one `app.use` in `main.ts`. Removing that call removes every header
above in one edit, and `X-Powered-By` returns. There is no configuration flag,
because unlike a rate limiter these headers cannot refuse a request — the worst
they do is constrain a browser, and the one that is hard to undo is documented
above.
