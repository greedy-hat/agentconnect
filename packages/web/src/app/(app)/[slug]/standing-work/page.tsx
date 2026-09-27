import type { Metadata } from 'next'
import StandingWorkView from '@/components/console/views/StandingWorkView'

export const metadata: Metadata = { title: 'Standing work · AgentConnect' }

export default function Page() {
  return <StandingWorkView />
}
