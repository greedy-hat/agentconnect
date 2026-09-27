import type { Metadata } from 'next'
import StandingWorkDetailView from '@/components/console/views/StandingWorkDetailView'

export const metadata: Metadata = { title: 'Standing work · AgentConnect' }

export default function Page() {
  return <StandingWorkDetailView />
}
