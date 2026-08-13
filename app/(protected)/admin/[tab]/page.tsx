import { notFound } from 'next/navigation'
import { AdminPanelPage, isAdminTab } from '../../settings/team/page'

export default function AdminTabPage({
  params,
}: {
  params: { tab: string }
}) {
  const { tab } = params

  if (!isAdminTab(tab)) {
    notFound()
  }

  return <AdminPanelPage initialTab={tab} />
}
