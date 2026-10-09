import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Button, Logo, useTheme } from '@reporter/ui';
import { useAuth } from '../auth.js';

/**
 * The page container, used by BOTH the header's inner row and `<main>`. The top
 * nav lines up with page content only while the two agree on the cap *and* the
 * gutter, so they share one string rather than two copies that can drift.
 *
 * `max-w-page` is 1352px, which is 1320px of content inside these `px-4` gutters —
 * the arithmetic is derived once in `packages/ui/src/theme.css`. Written as a
 * literal (not composed) so Tailwind's source scanner can see the class names.
 */
const PAGE_CONTAINER = 'mx-auto max-w-page px-4';

export function AppLayout() {
  const { user, logout } = useAuth();
  const { resolved, toggle } = useTheme();
  const navigate = useNavigate();

  async function onLogout() {
    // `logout()` clears local auth state even if the request fails, so ignore any
    // error and always land the user on /login. The public route tree would
    // redirect there on its own, but navigating makes it explicit and immediate.
    try {
      await logout();
    } catch {
      // already signed out locally; nothing more to do
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    // `overflow-x-clip` is a safety net against any stray horizontal overflow so
    // the page never gains a sideways scrollbar. It pairs with the default
    // vertical `visible` without creating a scroll container (unlike
    // `overflow-hidden`); wide content (code, HAR JSON) still scrolls inside its
    // own `min-w-0` boxes rather than being clipped.
    <div className="min-h-screen overflow-x-clip bg-bg text-text">
      <header className="border-b border-border bg-surface">
        <div className={`${PAGE_CONTAINER} flex h-14 items-center gap-4`}>
          <Link to="/engagements" className="flex items-center gap-2 font-semibold">
            <Logo size={26} />
            reporter
          </Link>
          <nav className="ml-4 flex items-center gap-1 text-sm">
            <TopLink to="/engagements">Engagements</TopLink>
            {user?.admin && <TopLink to="/admin">Admin</TopLink>}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={toggle}
              aria-label="Toggle theme"
              className="rounded-input p-2 text-muted hover:bg-surface-2 hover:text-text"
              title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
            >
              {resolved === 'dark' ? '☀' : '☾'}
            </button>
            <Link
              to="/account"
              className="rounded-input px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-text"
            >
              {user?.firstName} {user?.lastName}
            </Link>
            <Button variant="ghost" size="sm" onClick={onLogout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className={`${PAGE_CONTAINER} py-6`}>
        <Outlet />
      </main>
    </div>
  );
}

function TopLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-input px-3 py-1.5 font-medium transition-colors ${
          isActive ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
