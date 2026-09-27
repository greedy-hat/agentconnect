import type { Metadata } from 'next'
import PrincipalsView from '@/components/console/views/PrincipalsView'

export const metadata: Metadata = { title: 'Principals · AgentConnect' }

export default function Page() {
  return <PrincipalsView />
}
