# HawkView icon system

Use the shared glyphs in `lib/ui/product-icons.ts` wherever a product or service is identified. The same service must retain the same symbol in Baseline, tenant navigation, module headings, and collection status. These are generic line symbols, not copies of Microsoft or Google logos.

| Identity | Glyph | Colour in service views |
| --- | --- | --- |
| Microsoft 365 / Office 365 | four-panel outline | sky |
| Entra ID | fingerprint | indigo |
| SharePoint | open folder | emerald |
| OneDrive | cloud | cyan |
| Exchange | envelope | teal |
| SharePoint / OneDrive combined | open folder | emerald |
| Google Workspace provider | window panels | neutral slate |

Use the shared `ProviderMark` in `components/icons/provider-mark.tsx` for tenant and provider identity. It offers compact, small, and normal sizes. Labels beside icons must identify the service or provider; icons alone should not carry the meaning. Use the shared 1.9 stroke width and keep icon proportions consistent. Status and action symbols are a separate vocabulary: shields, warning triangles, checks, and locks must describe a state or action, never stand in for a service logo. Badge colour may still reflect status rather than the service hue.

`lib/ui/service-appearance.ts` owns the service hues and the matching light and dark mark, card, pill, and accent classes. Baseline and tenant modules must use the same hue for the same service. The combined SharePoint / OneDrive tenant module uses SharePoint emerald; a standalone OneDrive check uses cyan. Keep brand actions and focus rings blue, general surfaces slate, and reserve emerald, amber, and red for success, attention, and errors. Do not use a service hue to suggest assessment status.
