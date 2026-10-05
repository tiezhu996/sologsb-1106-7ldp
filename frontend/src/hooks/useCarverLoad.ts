import { derived, writable } from 'svelte/store'
import { blockStore } from '../stores/blockStore'
import { carverStore } from '../stores/carverStore'
import { db } from '../utils/db'

export function useCarverLoad(carverId: string) {
  const selectedCarverId = writable(carverId)
  const averageDuration = writable(0)
  let requestNumber = 0

  // 刻工负担 = 有效占用牌挂在其名下的版片数（期满或交回后自动撤下）
  const activeCount = derived(
    [selectedCarverId, carverStore.assignments],
    ([$carverId, $assignments]) => {
      if (!$carverId) return 0
      return ($assignments[$carverId] ?? []).length
    },
  )

  async function refresh(nextCarverId?: string): Promise<void> {
    if (nextCarverId !== undefined) selectedCarverId.set(nextCarverId)
    const currentId = nextCarverId ?? ''
    requestNumber += 1
    const currentRequest = requestNumber
    const current = currentId ? await db.carvers.get(currentId) : null

    if (!current) {
      if (currentRequest === requestNumber) averageDuration.set(0)
      return
    }

    const nodes = await db.nodes.where('operator').equals(current.name).toArray()
    const total = nodes.reduce((sum, node) => sum + node.durationMin, 0)
    const average = nodes.length === 0 ? 0 : Math.round(total / nodes.length)
    if (currentRequest === requestNumber) averageDuration.set(average)
  }

  void refresh(carverId)

  return { activeCount, averageDuration, refresh, selectedCarverId }
}
