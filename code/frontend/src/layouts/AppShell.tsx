import { NavLink, Outlet } from 'react-router-dom'
import type { ReactNode } from 'react'

import { Icon } from '@/components/ui/Icon'
import type { IconName } from '@/components/ui/Icon'
import { useAuth } from '@/hooks/useAuth'
import type { UserRole } from '@/types'

interface NavItem {
  to: string
  label: string
  icon: IconName
}

const CUSTOMER_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Home', icon: 'home' },
  { to: '/print', label: 'Print', icon: 'print' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/documents', label: 'Documents', icon: 'documents' },
  { to: '/profile', label: 'Profile', icon: 'profile' },
]

const STAFF_NAV: NavItem[] = [
  { to: '/staff', label: 'Queue', icon: 'shop' },
  { to: '/staff/pricing', label: 'Pricing', icon: 'bindings' },
  { to: '/staff/analytics', label: 'Analytics', icon: 'chart' },
  { to: '/profile', label: 'Profile', icon: 'profile' },
]

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Overview', icon: 'home' },
  { to: '/admin/shops', label: 'Shops', icon: 'shop' },
  { to: '/admin/orders', label: 'Orders', icon: 'orders' },
  { to: '/admin/staff', label: 'Staff', icon: 'profile' },
  { to: '/admin/pricing', label: 'Pricing', icon: 'bindings' },
  { to: '/admin/refunds', label: 'Refunds', icon: 'gift' },
  { to: '/admin/analytics', label: 'Analytics', icon: 'chart' },
]

function navForRole(role: UserRole): NavItem[] {
  if (role === 'ADMIN') return ADMIN_NAV
  if (role === 'SHOP_STAFF') return STAFF_NAV
  return CUSTOMER_NAV
}

// Exact-match routes - without `end`, NavLink matches by path prefix, so
// e.g. '/staff' would stay highlighted while on '/staff/pricing' or
// '/staff/orders/:id' too.
const EXACT_MATCH_ROUTES = new Set(['/admin', '/dashboard', '/staff'])

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function BrandMark() {
  return (
    <>
      <span className="auth-layout__brand-mark" style={{ width: 30, height: 30, fontSize: 14 }}>
        SP
      </span>
      <span className="auth-layout__brand-name" style={{ fontSize: 16 }}>
        SmartPrint
      </span>
    </>
  )
}

export function AppShell() {
  const { user, logout } = useAuth()
  if (!user) return null

  const navItems = navForRole(user.role)

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        <div className="shell__brand">
          <BrandMark />
        </div>
        <nav className="shell__nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={EXACT_MATCH_ROUTES.has(item.to)}
              className={({ isActive }) => `shell__nav-link ${isActive ? 'is-active' : ''}`}
            >
              <Icon name={item.icon} size={19} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="shell__sidebar-footer">
          <div className="shell__user">
            <span className="shell__avatar">{initials(user.name)}</span>
            <div>
              <div className="shell__user-name">{user.name}</div>
              <div className="shell__user-role">{roleLabel(user.role)}</div>
            </div>
          </div>
          <button className="shell__nav-link" style={{ border: 'none', background: 'none', cursor: 'pointer', width: '100%' }} onClick={logout}>
            <Icon name="logout" size={19} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="shell__main">
        <header className="shell__topbar">
          <div className="shell__topbar-brand">
            <BrandMark />
          </div>
          <button aria-label="Sign out" onClick={logout} className="shell__topbar-signout">
            <Icon name="logout" size={20} />
          </button>
        </header>

        <main className="shell__content">
          <Outlet />
        </main>

        <nav className="shell__bottomnav" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={EXACT_MATCH_ROUTES.has(item.to)}
              className={({ isActive }) => `shell__bottomnav-link ${isActive ? 'is-active' : ''}`}
            >
              <Icon name={item.icon} size={21} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}

function roleLabel(role: UserRole): string {
  switch (role) {
    case 'STUDENT':
      return 'Student'
    case 'FACULTY':
      return 'Faculty'
    case 'SHOP_STAFF':
      return 'Shop Staff'
    case 'ADMIN':
      return 'Administrator'
  }
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
