import { derived, writable } from 'svelte/store'
import type { Block } from '../types/block'
import type { Carver } from '../types/carver'
import type { BlockOccupancy, ClaimOp, ClaimOpKind, ClaimOpSnapshot } from '../types/occupancy'
import { db, SCHEMA_REV } from '../utils/db'
import { blockStore } from './blockStore'
import { carverStore } from './carverStore'

/** 占用牌两小时有效 */
export const OCCUPANCY_DURATION_MS = 2 * 60 * 60 * 1000
const CLOCK_INTERVAL_MS = 30 * 1000

export interface OccupancyResult {
  ok: boolean
  message: string
}

/** 一块版同时只认一张生效占用牌，冲突时抛出 */
class OccupancyConflict extends Error {}

const occupancyList = writable<BlockOccupancy[]>([])
const nowTick = writable(Date.now())
const recoveredList = writable<ClaimOp[]>([])

export function isOccupancyActive(occupancy: BlockOccupancy, now: number): boolean {
  if (occupancy.status !== '生效中') return false
  if (occupancy.expiresAt === null) return true
  return Date.parse(occupancy.expiresAt) > now
}

export function occupancyRemainingLabel(occupancy: BlockOccupancy, now: number): string {
  if (occupancy.expiresAt === null) return '历史占用 · 长期有效'
  const remainMs = Date.parse(occupancy.expiresAt) - now
  if (remainMs <= 0) return '已期满，待撤牌'
  const minutes = Math.ceil(remainMs / 60000)
  if (minutes >= 60) return `剩 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
  return `剩 ${minutes} 分钟`
}

/** 每块版当前生效的占用牌（一块版同时只认一张） */
const activeByBlock = derived([occupancyList, nowTick], ([$list, $now]) => {
  const map: Record<string, BlockOccupancy> = {}
  for (const occupancy of $list) {
    if (isOccupancyActive(occupancy, $now)) map[occupancy.blockId] = occupancy
  }
  return map
})

async function load(): Promise<void> {
  const records = await db.occupancies.toArray()
  records.sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))
  occupancyList.set(records)
}

async function refreshLinkedStores(): Promise<void> {
  await Promise.all([load(), blockStore.load(), carverStore.load()])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function snapshotFor(blockId: string, carverId: string | null): Promise<ClaimOpSnapshot> {
  const now = Date.now()
  const [occupancies, block, carvers] = await Promise.all([
    db.occupancies.where('blockId').equals(blockId).toArray(),
    db.blocks.get(blockId),
    db.carvers.toArray(),
  ])
  const carverBlockIds: Record<string, string[]> = {}
  for (const carver of carvers) {
    if (carver.id === carverId || carver.activeBlockIds.includes(blockId)) {
      carverBlockIds[carver.id] = [...carver.activeBlockIds]
    }
  }
  return {
    occupancies: occupancies.filter((item) => isOccupancyActive(item, now)),
    block: block ? { carvedBy: block.carvedBy, state: block.state } : null,
    carverBlockIds,
  }
}

/** 领用/交回先落一条操作日志（含原占用快照），写入中断后据此恢复 */
async function openOp(
  kind: ClaimOpKind,
  block: Block,
  carver: Carver | null,
  occupancyId: string | null,
): Promise<ClaimOp> {
  const op: ClaimOp = {
    id: `op-${crypto.randomUUID()}`,
    kind,
    blockId: block.id,
    carverId: carver?.id ?? '',
    carverName: carver?.name ?? '',
    occupancyId,
    status: '进行中',
    error: '',
    snapshot: await snapshotFor(block.id, carver?.id ?? null),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    schemaRev: SCHEMA_REV,
  }
  await db.claimOps.add(op)
  return op
}

/** 把占用牌、版片留名与刻工名单还原到操作前的快照 */
async function restoreSnapshot(op: ClaimOp): Promise<void> {
  await db.transaction('rw', [db.occupancies, db.blocks, db.carvers], async () => {
    if (op.kind === '领取' && op.occupancyId) await db.occupancies.delete(op.occupancyId)
    for (const occupancy of op.snapshot.occupancies) {
      await db.occupancies.put(occupancy)
    }
    if (op.snapshot.block) await db.blocks.update(op.blockId, op.snapshot.block)
    for (const [carverId, blockIds] of Object.entries(op.snapshot.carverBlockIds)) {
      await db.carvers.update(carverId, { activeBlockIds: [...blockIds] })
    }
  })
}

async function failOp(op: ClaimOp, error: unknown): Promise<string> {
  const message = errorMessage(error)
  try {
    await restoreSnapshot(op)
    await db.claimOps.update(op.id, { status: '已恢复', error: message, finishedAt: new Date().toISOString() })
    recoveredList.update((list) => [...list, { ...op, status: '已恢复', error: message }])
  } catch {
    await db.claimOps
      .update(op.id, { status: '待恢复', error: message })
      .catch(() => undefined)
  }
  return message
}

async function claim(block: Block, carverId: string): Promise<OccupancyResult> {
  const carver = await db.carvers.get(carverId)
  if (!carver) return { ok: false, message: '未找到刻工档案，请刷新后重试。' }

  const occupancyId = `occ-${crypto.randomUUID()}`
  const op = await openOp('领取', block, carver, occupancyId)
  try {
    await db.transaction('rw', [db.occupancies, db.blocks, db.carvers, db.claimOps], async () => {
      const now = Date.now()
      const siblings = await db.occupancies.where('blockId').equals(block.id).toArray()
      const holder = siblings.find((item) => isOccupancyActive(item, now))
      if (holder) {
        throw new OccupancyConflict(`「${block.blockName}」正由${holder.carverName}占用，一块版同时只认一张占用牌。`)
      }
      // 顺手结清已期满却未清扫的旧牌
      for (const item of siblings) {
        const overdue = item.status === '生效中' && item.expiresAt !== null && Date.parse(item.expiresAt) <= now
        if (overdue) await db.occupancies.update(item.id, { status: '已期满', releasedAt: item.expiresAt })
      }
      await db.occupancies.add({
        id: occupancyId,
        blockId: block.id,
        carverId: carver.id,
        carverName: carver.name,
        kind: '领取',
        status: '生效中',
        claimedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + OCCUPANCY_DURATION_MS).toISOString(),
        releasedAt: null,
        schemaRev: SCHEMA_REV,
      })
      await db.blocks.update(block.id, {
        carvedBy: carver.name,
        state: block.state === '待刻' ? '在刻' : block.state,
      })
      const allCarvers = await db.carvers.toArray()
      for (const item of allCarvers) {
        const without = item.activeBlockIds.filter((id) => id !== block.id)
        if (item.id === carver.id) {
          await db.carvers.update(item.id, { activeBlockIds: [...without, block.id] })
        } else if (without.length !== item.activeBlockIds.length) {
          await db.carvers.update(item.id, { activeBlockIds: without })
        }
      }
      await db.claimOps.update(op.id, { status: '已完成', finishedAt: new Date().toISOString() })
    })
  } catch (error) {
    if (error instanceof OccupancyConflict) {
      await db.claimOps.delete(op.id).catch(() => undefined)
      await refreshLinkedStores()
      return { ok: false, message: error.message }
    }
    const message = await failOp(op, error)
    await refreshLinkedStores()
    return { ok: false, message: `领用「${block.blockName}」时写入失败：${message}。已恢复原占用，可重开后继续。` }
  }
  await refreshLinkedStores()
  return { ok: true, message: `${carver.name}已领用「${block.blockName}」，占用牌两小时有效。` }
}

async function release(block: Block, options: { keepCarvedBy?: boolean } = {}): Promise<OccupancyResult> {
  const now = Date.now()
  const siblings = await db.occupancies.where('blockId').equals(block.id).toArray()
  const active = siblings.find((item) => isOccupancyActive(item, now)) ?? null
  const holder = active ? ((await db.carvers.get(active.carverId)) ?? null) : null
  const op = await openOp('交回', block, holder, active?.id ?? null)
  try {
    await db.transaction('rw', [db.occupancies, db.blocks, db.carvers, db.claimOps], async () => {
      const txNow = Date.now()
      const records = await db.occupancies.where('blockId').equals(block.id).toArray()
      const current = records.find((item) => isOccupancyActive(item, txNow))
      if (current) {
        await db.occupancies.update(current.id, { status: '已交回', releasedAt: new Date(txNow).toISOString() })
      }
      const allCarvers = await db.carvers.toArray()
      for (const carver of allCarvers) {
        if (!carver.activeBlockIds.includes(block.id)) continue
        await db.carvers.update(carver.id, {
          activeBlockIds: carver.activeBlockIds.filter((id) => id !== block.id),
        })
      }
      // 版片仍算在刻，只撤下名字；标刻成时保留留名作归档
      if (!options.keepCarvedBy) await db.blocks.update(block.id, { carvedBy: '' })
      await db.claimOps.update(op.id, { status: '已完成', finishedAt: new Date().toISOString() })
    })
  } catch (error) {
    const message = await failOp(op, error)
    await refreshLinkedStores()
    return { ok: false, message: `交回「${block.blockName}」时写入失败：${message}。已恢复原占用，可重开后继续。` }
  }
  await refreshLinkedStores()
  return { ok: true, message: `「${block.blockName}」占用牌已交回，版片仍算在刻，下一位可重新领用。` }
}

/** 期满撤牌：名单撤下、版片仍算在刻，下一位可重新领 */
async function sweepExpired(): Promise<void> {
  const now = Date.now()
  const activeRecords = await db.occupancies.where('status').equals('生效中').toArray()
  const due = activeRecords.filter((item) => item.expiresAt !== null && Date.parse(item.expiresAt) <= now)
  if (due.length === 0) return

  await db.transaction('rw', [db.occupancies, db.blocks, db.carvers], async () => {
    for (const occupancy of due) {
      await db.occupancies.update(occupancy.id, { status: '已期满', releasedAt: occupancy.expiresAt })
    }
    for (const occupancy of due) {
      const siblings = await db.occupancies.where('blockId').equals(occupancy.blockId).toArray()
      const activeSiblings = siblings.filter((item) => isOccupancyActive(item, now))
      if (activeSiblings.length === 0) {
        await db.blocks.update(occupancy.blockId, { carvedBy: '' })
      }
      const carver = await db.carvers.get(occupancy.carverId)
      if (!carver || !carver.activeBlockIds.includes(occupancy.blockId)) continue
      const stillHeld = activeSiblings.some((item) => item.carverId === occupancy.carverId)
      if (!stillHeld) {
        await db.carvers.update(carver.id, {
          activeBlockIds: carver.activeBlockIds.filter((id) => id !== occupancy.blockId),
        })
      }
    }
  })
  await refreshLinkedStores()
}

/** 重开时恢复中断的领用/交回：还原原占用，操作草稿留给工台继续办理 */
async function recoverPendingOps(): Promise<void> {
  const pending = await db.claimOps.where('status').anyOf('进行中', '待恢复').toArray()
  if (pending.length === 0) return
  const recovered: ClaimOp[] = []
  for (const op of pending) {
    try {
      await restoreSnapshot(op)
      await db.claimOps.update(op.id, { status: '已恢复', finishedAt: new Date().toISOString() })
      recovered.push({ ...op, status: '已恢复' })
    } catch {
      // 保留原状态，下次启动再恢复
    }
  }
  if (recovered.length > 0) recoveredList.set(recovered)
}

let clockTimer: ReturnType<typeof setInterval> | null = null

async function tickClock(): Promise<void> {
  nowTick.set(Date.now())
  await sweepExpired()
  await refreshLinkedStores()
}

function startClock(): void {
  if (clockTimer !== null) return
  clockTimer = setInterval(() => {
    void tickClock()
  }, CLOCK_INTERVAL_MS)
}

async function init(): Promise<void> {
  await recoverPendingOps()
  await sweepExpired()
  await load()
  startClock()
}

function dismissRecovered(opId: string): void {
  recoveredList.update((list) => list.filter((op) => op.id !== opId))
}

export const occupancyStore = {
  subscribe: occupancyList.subscribe,
  activeByBlock,
  now: { subscribe: nowTick.subscribe },
  recovered: { subscribe: recoveredList.subscribe },
  load,
  init,
  claim,
  release,
  sweepExpired,
  dismissRecovered,
}
