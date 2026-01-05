# HawkView

Enterprise SaaS Management Platform - Next.js Frontend

## Overview

HawkView is an enterprise-grade frontend skeleton for a SaaS application built with:
- **Next.js 14** with App Router
- **TypeScript** for type safety
- **Tailwind CSS** for styling
- **shadcn/ui** for UI components
- **TanStack React Query** for data fetching
- **Zod** for validation

## Project Structure

```
├── app/
│   ├── (public)/login/          # Public login page
│   ├── (protected)/             # Protected routes with sidebar layout
│   │   ├── tenants/
│   │   ├── dashboard/
│   │   ├── reports/
│   │   └── settings/
│   ├── globals.css
│   ├── layout.tsx               # Root layout with QueryProvider
│   └── page.tsx                 # Redirects to /login
├── components/
│   ├── common/                  # EmptyState, LoadingState, ErrorState
│   ├── layout/                  # Sidebar, Topbar
│   ├── providers/               # React Query provider
│   └── ui/                      # shadcn/ui components
├── lib/
│   ├── api/                     # API client and React Query hooks
│   └── utils.ts                 # Utility functions
├── types/                       # TypeScript types with Zod schemas
└── middleware.ts                # Route protection
```

## Key Features

- **Route Groups**: `(public)` for unauthenticated pages, `(protected)` for authenticated
- **Cookie-based Auth**: Placeholder using `hawkview-session` cookie
- **Empty States**: Professional empty-state messages for all pages
- **Typed API Layer**: Ready for backend integration

## Development

```bash
npm run dev     # Start dev server on port 5000
npm run build   # Build for production
npm run lint    # Run ESLint
```

## Authentication

Currently uses a "Dev Sign In" button that sets a session cookie. To integrate Microsoft Entra ID:
1. Install MSAL packages
2. Configure Azure App Registration
3. Replace Dev Sign In with MSAL login flow

See README.md for detailed instructions.

## Recent Changes

- 2026-01-05: Initial project setup with all pages, components, and routing
