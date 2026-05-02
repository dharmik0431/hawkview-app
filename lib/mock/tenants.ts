export type Provider = 'microsoft' | 'google'
export type TenantStatus = 'healthy' | 'warning' | 'critical'

export type Tenant = {
  id: string
  name: string
  domain: string
  provider: Provider
  secureScore: number
  licenseCount: number
  status: TenantStatus
  lastSync: string
}

export const TENANTS: Tenant[] = [
  {
    id: 'alphatech-ms',
    name: 'AlphaTech Inc.',
    domain: 'alphatech.com',
    provider: 'microsoft',
    secureScore: 72,
    licenseCount: 150,
    status: 'healthy',
    lastSync: '3 minutes ago',
  },
  {
    id: 'betasolutions-gw',
    name: 'BetaSolutions LLC',
    domain: 'betasolutions.com',
    provider: 'google',
    secureScore: 85,
    licenseCount: 75,
    status: 'healthy',
    lastSync: '5 minutes ago',
  },
  {
    id: 'gamma-ms',
    name: 'Gamma Enterprises',
    domain: 'gamma-enterprises.co',
    provider: 'microsoft',
    secureScore: 38,
    licenseCount: 320,
    status: 'critical',
    lastSync: '1 hour ago',
  },
  {
    id: 'delta-gw',
    name: 'Delta Dynamics',
    domain: 'deltadynamics.io',
    provider: 'google',
    secureScore: 91,
    licenseCount: 210,
    status: 'warning',
    lastSync: '12 minutes ago',
  },
  {
    id: 'epsilon-ms',
    name: 'Epsilon Innovations',
    domain: 'epsilon.com',
    provider: 'microsoft',
    secureScore: 88,
    licenseCount: 45,
    status: 'healthy',
    lastSync: '2 minutes ago',
  },
]
