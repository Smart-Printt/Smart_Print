import { PageHeader } from '@/layouts/AppShell'
import { StateBlock } from '@/components/ui/StateBlock'
import { useAuth } from '@/hooks/useAuth'
import { AnalyticsPage } from '@/pages/shared/AnalyticsPage'

// A shop owner's analytics: only their own shop. The shop id comes from the
// signed-in staff account; the server independently re-checks that the
// account is active and assigned to exactly that shop.
export function StaffAnalyticsPage() {
  const { user } = useAuth()
  const shopId = user?.shopId ?? null

  if (!shopId) {
    return (
      <div>
        <PageHeader title="Analytics" />
        <StateBlock
          icon="alert"
          title="No print shop assigned"
          description="Your staff account is not assigned to a print shop. Please contact an administrator."
        />
      </div>
    )
  }

  return <AnalyticsPage shopId={shopId} />
}
