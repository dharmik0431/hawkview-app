export interface Tenant {
  id: string
  name: string
  domain: string
  provider: 'microsoft' | 'google'
  secureScore: number
  mfaCoverage: number
  licenseCount: number
  licenseUsed: number
  userCount: number
  status: 'healthy' | 'warning' | 'critical'
  lastSync: string
}

export const tenants: Tenant[] = [
  {
    id: 'contoso-ms',
    name: 'Contoso Ltd',
    domain: 'contoso.com',
    provider: 'microsoft',
    secureScore: 87,
    mfaCoverage: 94,
    licenseCount: 150,
    licenseUsed: 142,
    userCount: 142,
    status: 'healthy',
    lastSync: '5 minutes ago',
  },
  {
    id: 'northwind-ms',
    name: 'Northwind Traders',
    domain: 'northwind.io',
    provider: 'microsoft',
    secureScore: 62,
    mfaCoverage: 78,
    licenseCount: 85,
    licenseUsed: 79,
    userCount: 79,
    status: 'warning',
    lastSync: '12 minutes ago',
  },
  {
    id: 'acme-gw',
    name: 'Acme Corp',
    domain: 'acme.org',
    provider: 'google',
    secureScore: 91,
    mfaCoverage: 100,
    licenseCount: 200,
    licenseUsed: 187,
    userCount: 187,
    status: 'healthy',
    lastSync: '2 minutes ago',
  },
  {
    id: 'globex-ms',
    name: 'Globex Industries',
    domain: 'globex.net',
    provider: 'microsoft',
    secureScore: 45,
    mfaCoverage: 52,
    licenseCount: 320,
    licenseUsed: 298,
    userCount: 298,
    status: 'critical',
    lastSync: '28 minutes ago',
  },
  {
    id: 'initech-gw',
    name: 'Initech Solutions',
    domain: 'initech.dev',
    provider: 'google',
    secureScore: 78,
    mfaCoverage: 89,
    licenseCount: 45,
    licenseUsed: 41,
    userCount: 41,
    status: 'healthy',
    lastSync: '8 minutes ago',
  },
  {
    id: 'umbrella-ms',
    name: 'Umbrella Corp',
    domain: 'umbrella.co',
    provider: 'microsoft',
    secureScore: 58,
    mfaCoverage: 65,
    licenseCount: 180,
    licenseUsed: 172,
    userCount: 172,
    status: 'warning',
    lastSync: '15 minutes ago',
  },
]

export interface User {
  id: string
  name: string
  email: string
  role: string
  mfaEnabled: boolean
  lastSignIn: string
  status: 'active' | 'inactive' | 'suspended'
}

export const mockUsers: User[] = [
  { id: '1', name: 'John Smith', email: 'john.smith@contoso.com', role: 'Admin', mfaEnabled: true, lastSignIn: '2 hours ago', status: 'active' },
  { id: '2', name: 'Sarah Connor', email: 'sarah.connor@contoso.com', role: 'User', mfaEnabled: true, lastSignIn: '1 day ago', status: 'active' },
  { id: '3', name: 'Mike Johnson', email: 'mike.j@contoso.com', role: 'User', mfaEnabled: false, lastSignIn: '3 days ago', status: 'active' },
  { id: '4', name: 'Emily Davis', email: 'emily.d@contoso.com', role: 'Manager', mfaEnabled: true, lastSignIn: '5 hours ago', status: 'active' },
  { id: '5', name: 'Tom Wilson', email: 'tom.w@contoso.com', role: 'User', mfaEnabled: false, lastSignIn: '1 week ago', status: 'inactive' },
]

export interface License {
  id: string
  name: string
  sku: string
  total: number
  assigned: number
  available: number
}

export const mockLicenses: License[] = [
  { id: '1', name: 'Microsoft 365 E3', sku: 'M365_E3', total: 100, assigned: 95, available: 5 },
  { id: '2', name: 'Microsoft 365 E5', sku: 'M365_E5', total: 30, assigned: 28, available: 2 },
  { id: '3', name: 'Power BI Pro', sku: 'PBI_PRO', total: 20, assigned: 19, available: 1 },
]

export interface Alert {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  timestamp: string
}

export const mockAlerts: Alert[] = [
  { id: '1', severity: 'high', title: 'MFA Disabled for Admin Account', description: 'Admin user john.smith@contoso.com has MFA disabled', timestamp: '10 minutes ago' },
  { id: '2', severity: 'medium', title: 'License Overallocation Warning', description: 'M365 E3 licenses at 95% utilization', timestamp: '1 hour ago' },
  { id: '3', severity: 'low', title: 'Sync Delay Detected', description: 'Last sync took longer than expected', timestamp: '3 hours ago' },
]
