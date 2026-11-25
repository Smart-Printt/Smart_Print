import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { FullPageLoader, RequireAuth, RequireGuest, RequireRole, homeRouteForRole } from '@/routes/guards'
import { AppShell } from '@/layouts/AppShell'
import { AuthProvider } from '@/context/AuthContext'
import { ToastProvider } from '@/context/ToastContext'
import { ToastViewport } from '@/components/ui/ToastViewport'
import { useAuth } from '@/hooks/useAuth'

function RootRedirect() {
  const { user } = useAuth()
  return <Navigate to={user ? homeRouteForRole(user.role) : '/login'} replace />
}

const LoginPage = lazy(() => import('@/pages/auth/LoginPage').then((m) => ({ default: m.LoginPage })))
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage').then((m) => ({ default: m.RegisterPage })))
const ForgotPasswordPage = lazy(() =>
  import('@/pages/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
)
const ResetPasswordPage = lazy(() =>
  import('@/pages/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
)

const DashboardPage = lazy(() => import('@/pages/student/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const DocumentsPage = lazy(() => import('@/pages/student/DocumentsPage').then((m) => ({ default: m.DocumentsPage })))
const OrdersPage = lazy(() => import('@/pages/student/OrdersPage').then((m) => ({ default: m.OrdersPage })))
const OrderDetailsPage = lazy(() => import('@/pages/student/OrderDetailsPage').then((m) => ({ default: m.OrderDetailsPage })))
const ProfilePage = lazy(() => import('@/pages/shared/ProfilePage').then((m) => ({ default: m.ProfilePage })))
const PrintFlowPage = lazy(() => import('@/pages/student/print-flow/PrintFlowPage').then((m) => ({ default: m.PrintFlowPage })))

const StaffDashboardPage = lazy(() => import('@/pages/staff/StaffDashboardPage').then((m) => ({ default: m.StaffDashboardPage })))
const StaffPricingPage = lazy(() => import('@/pages/staff/StaffPricingPage').then((m) => ({ default: m.StaffPricingPage })))
const StaffOrderDetailsPage = lazy(() => import('@/pages/staff/StaffOrderDetailsPage').then((m) => ({ default: m.StaffOrderDetailsPage })))

const AdminOverviewPage = lazy(() => import('@/pages/admin/AdminOverviewPage').then((m) => ({ default: m.AdminOverviewPage })))
const AdminShopsPage = lazy(() => import('@/pages/admin/AdminShopsPage').then((m) => ({ default: m.AdminShopsPage })))
const AdminOrdersPage = lazy(() => import('@/pages/admin/AdminOrdersPage').then((m) => ({ default: m.AdminOrdersPage })))
const AdminStaffPage = lazy(() => import('@/pages/admin/AdminStaffPage').then((m) => ({ default: m.AdminStaffPage })))
const AdminPricingPage = lazy(() => import('@/pages/admin/AdminPricingPage').then((m) => ({ default: m.AdminPricingPage })))
const AnalyticsPage = lazy(() => import('@/pages/shared/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))
const StaffAnalyticsPage = lazy(() => import('@/pages/staff/StaffAnalyticsPage').then((m) => ({ default: m.StaffAnalyticsPage })))
const AdminRefundsPage = lazy(() => import('@/pages/admin/AdminRefundsPage').then((m) => ({ default: m.AdminRefundsPage })))

const ForbiddenPage = lazy(() => import('@/pages/errors/ForbiddenPage').then((m) => ({ default: m.ForbiddenPage })))
const NotFoundPage = lazy(() => import('@/pages/errors/NotFoundPage').then((m) => ({ default: m.NotFoundPage })))

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<FullPageLoader />}>
            <Routes>
              <Route element={<RequireGuest />}>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
              </Route>

              <Route path="/403" element={<ForbiddenPage />} />

              <Route element={<RequireAuth />}>
                <Route element={<AppShell />}>
                  <Route element={<RequireRole roles={['STUDENT', 'FACULTY']} />}>
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/documents" element={<DocumentsPage />} />
                    <Route path="/orders" element={<OrdersPage />} />
                    <Route path="/orders/:orderId" element={<OrderDetailsPage />} />
                    <Route path="/print" element={<PrintFlowPage />} />
                  </Route>

                  <Route element={<RequireRole roles={['SHOP_STAFF']} />}>
                    <Route path="/staff" element={<StaffDashboardPage />} />
                    <Route path="/staff/pricing" element={<StaffPricingPage />} />
                    <Route path="/staff/analytics" element={<StaffAnalyticsPage />} />
                    <Route path="/staff/orders/:orderId" element={<StaffOrderDetailsPage />} />
                  </Route>

                  <Route element={<RequireRole roles={['ADMIN']} />}>
                    <Route path="/admin" element={<AdminOverviewPage />} />
                    <Route path="/admin/shops" element={<AdminShopsPage />} />
                    <Route path="/admin/orders" element={<AdminOrdersPage />} />
                    <Route path="/admin/staff" element={<AdminStaffPage />} />
                    <Route path="/admin/pricing" element={<AdminPricingPage />} />
                    <Route path="/admin/refunds" element={<AdminRefundsPage />} />
                    <Route path="/admin/analytics" element={<AnalyticsPage />} />
                  </Route>

                  <Route path="/profile" element={<ProfilePage />} />
                </Route>
              </Route>

              <Route path="/" element={<RootRedirect />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
          <ToastViewport />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
