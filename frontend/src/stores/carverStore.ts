import { derived, writable } from 'svelte/store'
import type { Carver } from '../types/carver'
import type { Block } from '../types/block'
import { db } from '../utils/db'
import { occupationStore } from './occupationStore'
import { isActiveOccupation } from '../utils/occupation'

const carverList = writable<Carver[]>([])

/** 刻工当班名单以「有效期内的占用牌」为唯一事实来源；期满/交回即撤下 */
export const carverAssignments = derived(
  [occupationStore, occupationStore.nowTick],
  ([$occupations, now]) => {
    const assignments: Record<string, string[]> = {}
    for (const occupation of $occupations) {
      if (!isActiveOccupation(occupation, now) || !occupation.holderCarverId) continue
      const ids = assignments[occupation.holderCarverId] ?? []
      ids.push(occupation.blockId)
      assignments[occupation.holderCarverId] = ids
    }
    return assignments
  },
)

const assignmentSummary = derived(carverAssignments, ($assignments) => {
  const summary: Record<string, number> = {}
  for (const blockIds of Object.values($assignments)) {
    for (const blockId of blockIds) {
      summary[blockId] = (summary[blockId] ?? 0) + 1
    }
  }
  return summary
})

async function load(): Promise<void> {
  const records = await db.carvers.toArray()
  records.sort((a, b) => a.specialty.localeCompare(b.specialty, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
  carverList.set(records)
}

async function create(input: Omit<Carver, 'id'>): Promise<string> {
  const id = `carver-${crypto.randomUUID()}`
  await db.carvers.add({ id, ...input })
  await load()
  return id
}

async function update(id: string, changes: Partial<Omit<Carver, 'id'>>): Promise<void> {
  await db.carvers.update(id, changes)
  await load()
}

/** 兼容旧调用：转成领取两小时占用牌（一块版同时只认一张牌） */
async function assignBlock(block: Block, carverId: string): Promise<void> {
  await occupationStore.claim(block, carverId)
}

/** 交回占用牌：名单撤下，版片仍算在刻 */
async function releaseBlock(blockId: string): Promise<void> {
  const block = await db.blocks.get(blockId)
  if (block) await occupationStore.returnBlock(block)
}

export const carverStore = {
  subscribe: carverList.subscribe,
  assignments: carverAssignments,
  assignmentSummary,
  load,
  create,
  update,
  assignBlock,
  releaseBlock,
}
