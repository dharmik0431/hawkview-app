# Two fixes verified: the unrecognised key at both ends, and the fleet of zero

## 1. `73222f6` + `b756927` — a saved setting with no row to appear on

`backend/src/alerts/qa-unrecognised-keys.ts`, against the real endpoint over HTTP with the real
auth path, and the real tick over the same database in the same run. Bound to `ac6318f`.

**Both ends name it, and they name the key rather than a placeholder.**

| what is stored | the endpoint's `unrecognisedKeys` | the tick's `unreadableDispositions` |
|---|---|---|
| nothing | `[]` | `[]` |
| one valid row | `[]` | `[]` — and no `storedValueIgnored` either |
| `HV-ID-AUTH-010.v1` | `["HV-ID-AUTH-010.v1"]` | that key, `because: UNKNOWN_ALERT_TYPE` |
| `HV-ID-MBX-001.v1` | `["HV-ID-MBX-001.v1"]` | that key |
| both, plus a valid row | both, sorted | both |
| a valid key holding `RING` | `[]` | that key, `because: UNKNOWN_DISPOSITION` |

**The checks that separate a report from a constant.** The output *follows* the key: two different
unrecognised keys produce two different answers, so a fixed string dressed as an attribution fails.
A run with nothing stored names **nothing** rather than something empty. A valid row appears in
neither list. And the two arms stay distinct — an unreadable **value** appears on its own row as
`storedValueIgnored` and is *not* in the key list, while an unreadable **key** is in the key list
and has no row.

**And the reporting is not achieved by the lookup breaking.** In the mixed case the valid row is
`RECORD_ONLY`, and the tick still wrote **0 jobs** — the setting that could take effect still did,
while the two that could not were named.

## 2. `c87416b` — a fleet of zero is not a fleet that was checked

Same render harness as the first run, same three registered fixtures, plus the two degenerate ones.
**R5, R6, R8 and R9 now all hold**, and there are five distinct empty states where there were three.

| fixture | what a person sees | green shields |
|---|---|---|
| four tenants, all assessed | No users require review · All 4 tenants in scope were assessed… | **2** |
| three of four unreadable | No users to review among the tenants HawkView assessed · 3 of 4 tenants were not assessed (1 could not be reached, 2 returned no assessment): **ten-1, ten-2, ten-3** | 0 |
| all four still loading | …4 of 4 not assessed (4 still loading): ten-0, ten-1, ten-2, **and 1 more** | 0 |
| genuinely no tenants | No tenants are in scope · *There is nothing to assess, which is not the same as nothing being wrong.* | 0 |
| the tenant list failed | **HawkView could not determine which tenants to assess** · *…so HawkView does not know which tenants exist. Nothing here is a statement about your tenants, and no tenant has been assessed or cleared.* | 0 |

The last two are the finding closed twice over: the green shield is gone from both, **and** the two
are no longer the same screen. A `FleetSize` union of `KNOWN | UNKNOWN` derived from the hook's
`isError` is in the code — the same shape the register carried, arrived at from the failure rather
than from the register, since they had not read it.

**R8 is met**: the missed tenants are named, with a truncation that says how many more.

### My own extractor was one tone short

My title check was a fixed list of the three strings the previous version produced. Against the new
code two fixtures returned `title: null` — which looks exactly like nothing rendered, and I had
`GREEN_SHIELDS: 0` beside it, which is the answer I wanted. Both together read as a pass.

They were not nothing. They were a **fourth** and **fifth** tone my list did not contain. The tell
was `htmlBytes` differing between two fixtures I expected to be identical, which is the field I
added after the last run for exactly this reason. Printing the text instead of matching a list is
what produced the table above.
