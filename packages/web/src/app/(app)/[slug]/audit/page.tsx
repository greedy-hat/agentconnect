import type { Metadata } from 'next'
import AuditView from '@/components/console/views/AuditView'

export const metadata: Metadata = { title: 'Audit · AgentConnect' }

export default function Page() {
  return <AuditView />
}
