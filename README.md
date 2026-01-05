# HawkView

Enterprise SaaS Management Platform - Frontend Skeleton

## Tech Stack

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: shadcn/ui
- **State Management**: TanStack React Query
- **Validation**: Zod

## Getting Started

```bash
npm install
npm run dev
```

The app will be available at http://localhost:5000

## Project Structure

```
├── app/
│   ├── (public)/           # Public routes (no auth required)
│   │   └── login/
│   ├── (protected)/        # Protected routes (auth required)
│   │   ├── layout.tsx      # Shared layout with sidebar + topbar
│   │   ├── tenants/
│   │   ├── dashboard/
│   │   ├── reports/
│   │   └── settings/
│   ├── globals.css
│   ├── layout.tsx          # Root layout
│   └── page.tsx            # Redirects to /login
├── components/
│   ├── common/             # Shared components
│   │   ├── empty-state.tsx
│   │   ├── error-state.tsx
│   │   └── loading-state.tsx
│   ├── layout/             # Layout components
│   │   ├── sidebar.tsx
│   │   └── topbar.tsx
│   ├── providers/
│   │   └── query-provider.tsx
│   └── ui/                 # shadcn/ui components
├── lib/
│   ├── api/
│   │   ├── client.ts       # Fetch wrapper
│   │   └── hooks.ts        # React Query hooks
│   └── utils.ts
├── types/
│   ├── api.ts              # API types with Zod schemas
│   └── index.ts
└── middleware.ts           # Route protection
```

## Routing

### Route Groups

- `(public)` - Routes that don't require authentication (e.g., /login)
- `(protected)` - Routes that require authentication

### Available Routes

| Route | Description | Auth Required |
|-------|-------------|---------------|
| `/login` | Login page with Dev Sign In | No |
| `/tenants` | Tenant management | Yes |
| `/dashboard` | Overview dashboard | Yes |
| `/reports` | Analytics and reports | Yes |
| `/settings` | Application settings | Yes |

## Authentication

### Current Implementation (Development)

The app uses a simple cookie-based session for development:

1. **Dev Sign In**: Sets a `hawkview-session` cookie
2. **Middleware**: Checks for this cookie on protected routes
3. **Sign Out**: Clears the cookie

### Swapping to Microsoft Entra ID

To implement real Microsoft authentication:

1. Install MSAL libraries:
   ```bash
   npm install @azure/msal-browser @azure/msal-react
   ```

2. Create Azure App Registration in Azure Portal

3. Create `lib/auth/msal-config.ts`:
   ```typescript
   export const msalConfig = {
     auth: {
       clientId: process.env.NEXT_PUBLIC_AZURE_CLIENT_ID!,
       authority: `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_TENANT_ID}`,
       redirectUri: process.env.NEXT_PUBLIC_REDIRECT_URI,
     },
   }
   ```

4. Wrap app in MSAL Provider

5. Replace the Dev Sign In button with MSAL login

6. Update middleware to validate real tokens

## API Integration

### Current State

The API hooks return empty data structures. When ready to connect:

1. Set `NEXT_PUBLIC_API_URL` environment variable
2. Update `lib/api/hooks.ts` to call real endpoints
3. Use the typed responses from `types/api.ts`

### Example Hook Update

```typescript
export function useTenants() {
  return useQuery<TenantsResponse>({
    queryKey: ['tenants'],
    queryFn: () => apiClient.get('/api/tenants'),
  })
}
```

## UI Components

Built with shadcn/ui patterns. To add more components:

1. Check https://ui.shadcn.com for component code
2. Copy to `components/ui/`
3. Customize as needed

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Base URL for API endpoints |
| `NEXT_PUBLIC_AZURE_CLIENT_ID` | Azure App Registration Client ID |
| `NEXT_PUBLIC_AZURE_TENANT_ID` | Azure Tenant ID |
| `NEXT_PUBLIC_REDIRECT_URI` | OAuth redirect URI |
