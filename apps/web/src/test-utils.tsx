// The page-level test harness. Every jsdom test that mounts something which
// reads a query, a route param or a theme wraps it here, so each file carries
// one line of setup rather than its own copy of main.tsx's provider stack.
//
// The QueryClient is built per render with `retry: false` (a failing query must
// fail once, not after three backoffs the fake timers never advance) and
// `gcTime: 0` (nothing outlives the test that cached it). The theme is pinned to
// `light` with persistence off: in `system` mode the provider subscribes to
// `matchMedia`, which jsdom does not implement, and a persisted mode would leak
// between tests through localStorage.
//
// Callers that mock `api/hooks.js` wholesale (the TagManager precedent) still
// get a working QueryClient here — it is simply never asked anything.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider, ThemeProvider, ToastProvider } from '@reporter/ui';
import type { ReactElement, ReactNode } from 'react';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** The initial location, e.g. `/engagements/op1/audit-log?page=2`. Default `/`. */
  route?: string;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
}

/** A QueryClient that fails fast and forgets everything when the test ends. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Mount `ui` under the same providers the app runs under — QueryClient, theme,
 * toasts, confirm dialogs and a memory router parked at `route` — and return
 * the RTL result plus the QueryClient, so a test can seed or inspect the cache.
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', ...options }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider defaultMode="light" persist={false}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <ConfirmProvider>
              <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
            </ConfirmProvider>
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient };
}
