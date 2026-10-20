import {
  Cloud,
  Fingerprint,
  FolderOpen,
  Grid2X2,
  Mail,
  PanelsTopLeft,
  ScrollText,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react'

/**
 * HawkView's service pictograms. These generic line symbols are intentionally
 * not Microsoft product logos. Reuse them anywhere a service is identified;
 * reserve shields, warnings, and checks for status or actions.
 */
export const PRODUCT_ICON_STROKE_WIDTH = 1.9

export const productIcons = {
  microsoft365: Grid2X2,
  googleWorkspace: PanelsTopLeft,
  entra: Fingerprint,
  sharepoint: FolderOpen,
  onedrive: Cloud,
  sharepointOneDrive: FolderOpen,
  exchange: Mail,
  signIns: UserRoundCheck,
  auditLogs: ScrollText,
} satisfies Record<string, LucideIcon>

export const baselineServiceIcons = {
  Entra: productIcons.entra,
  SharePoint: productIcons.sharepoint,
  OneDrive: productIcons.onedrive,
  Exchange: productIcons.exchange,
  'Microsoft 365': productIcons.microsoft365,
} satisfies Record<string, LucideIcon>
