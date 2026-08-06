# HawkView tenant workspace visual system

## Audit

The previous workspace flattened the tenant navigation, but the modules still relied on repeated white rounded cards, oversized empty containers, inconsistent table headers, nested tabs, generic blue accents, and one-off status treatments. Office 365, Entra, Exchange, and SharePoint were visually interchangeable. Risks and freshness competed with ordinary inventory data.

## Visual proposal

- **Structure:** navy tenant identity band, compact horizontal module rail, neutral operational canvas.
- **Service identity:** Office blue, Entra violet, Exchange cyan, SharePoint teal, Teams purple. Service colors identify location only.
- **Status:** green healthy, blue syncing, amber attention, red disconnected/critical, violet stale/partial, gray unsupported.
- **Typography:** tenant 20px/semibold, module 18px/semibold, section 14px/semibold, operational values 20–28px/bold, metadata 12–13px.
- **Surfaces:** elevated treatment is reserved for tenant context and active investigations. Inventories use flat sections, dividers, and tinted sticky headers.
- **Tables:** compact rows, sticky tinted headers, strong primary column, right-aligned numbers, service-colored hover rail.
- **Drawers:** 40–50% desktop width, full-screen mobile, entity header followed by summary, evidence, freshness, and actions.

## Wireframes

### Tenant overview

`Tenant identity band → status strip → needs-attention queue | service health → recent evidence`

### Office 365

`Office identity → compact protection/capacity strip → license inventory → domain protection rows`

### Entra overview

`Entra identity → identity-risk strip → users/groups/apps summary → recent sign-in and directory evidence`

### Entra sign-in activity

`Source/fidelity notice → search + filters + map/list → evidence table → wide event drawer`

### Exchange

`Exchange identity → risk strip → mailbox inventory → forwarding/rules → domains/groups`

### SharePoint/OneDrive

`SharePoint identity → exposure/storage strip → site inventory → governance findings → compact data coverage`

## Removed and flattened

- The permanent tenant sidebar remains removed.
- Tenant identity and operational status become one coordinated band.
- Module identity is no longer a small heading competing with page content.
- Repeated metric cards on the overview become a single status band.
- Service navigation uses one layer; Entra sub-navigation remains contextual inside Entra only.
- Unsupported data belongs in compact coverage messaging rather than large empty cards.

## Responsive behavior

- Desktop uses the full workspace width and places primary inventories above the fold.
- Tablet stacks status regions into two columns and hides secondary metadata where needed.
- Mobile condenses tenant identity, makes module navigation horizontally scrollable, stacks operational sections, and uses full-screen drawers.
