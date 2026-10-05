import { derived, get, writable } from 'svelte/store'
import type { Block } from '../types/block'
import type {
  OccupationHistoryEntry,
  OccupationOperation,
  OccupationRecord,
} from '../types/occupation'
import { db } from '../utils/db'
import { isActiveOccupation, OCCUPATION_TTL_MS } from '../utils/occupation'

/**
 * 领用占用牌（两小时有效）。
 *
 * 一致性要点：
 * - occupations 主键就是 blockId，一块版一行，结构上杜绝一张版挂两张牌；
 * - claim 的「查牌 → 定夺 → 写牌」全部放在同一个 rw 事务内。
 *   IndexedDB 对对象库范围重叠的读写事务按顺序串行执行，
 *   两个窗口同时点领取，只会有一个事务成功，另一个拿到 ConflictError。
 * - 操作意向（occupationOps）先于主事务落盘；主事务整体提交或整体回滚，
 *   崩溃重开由 recoverInterrupted 按 snapshot 对账，恢复原占用/原版状态/原名单。
 */

const occupationList = writable<OccupationRecord[]>([])
const opList = writable<OccupationOperation[]>([])

/** blockId -> 当前占用牌（含已过期/已交回的最近一张，UI 据此展示） */
export const occupationByBlock = derived(occupationList, ($occupations) => {
  const map = new Map<string, OccupationRecord>()
  for (const occupation of $occupations) map.set(occupation.blockId, occupation)
  return map
})

export const occupationOperations = opList

/** 每 30 秒走一下的时钟，驱动「剩余 1 小时 12 分」类派生展示 */
export const nowTick = writable(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
function ensureTicker(): void {
  if (tickTimer === null && typeof window !== 'undefined') {
    tickTimer = setInterval(() => nowTick.set(Date.now()), 30_000)
  }
}

function historyEntryFor(
  occupation: OccupationRecord | null,
  carverId: string,
  carverName: string,
  claimedAt: string,
  expiresAt: string,
): OccupationHistoryEntry {
  const maxSeq = occupation ? Math.max(0, ...occupation.history.map((item) => item.seq)) : 0
  return { seq: maxSeq + 1, kind: 'claim', carverId, carverName, claimedAt, expiresAt, endedAt: null, endReason: null, note: '' }
}

function freshOccupation(
  blockId: string,
  carverId: string,
  carverName: string,
  claimedAt: string,
  expiresAt: string,
): OccupationRecord {
  return {
    blockId,
    status: 'active',
    holderCarverId: carverId,
    holderCarverName: carverName,
    claimedAt,
    expiresAt,
    releasedAt: null,
    history: [historyEntryFor(null, carverId, carverName, claimedAt, expiresAt)],
  }
}

/** 把当前牌转入关闭态，并把对应历史条目补成闭合记录 */
function closeOccupation(
  occupation: OccupationRecord,
  endedAt: string,
  status: 'expired' | 'returned',
  endReason: 'expired' | 'returned',
): OccupationRecord {
  const history = occupation.history.map((entry) =>
    entry.seq === occupation.history.length && entry.endedAt === null
      ? { ...entry, endedAt, endReason }
      : entry,
  )
  return {
    ...occupation,
    status,
    holderCarverId: null,
    holderCarverName: null,
    releasedAt: endedAt,
    history,
  }
}

/** 同一刻工续领：旧牌闭合入历史，换发一张新牌 */
function renewOccupation(
  occupation: OccupationRecord,
  carverId: string,
  carverName: string,
  claimedAt: string,
  expiresAt: string,
): OccupationRecord {
  const closed = closeOccupation(occupation, claimedAt, 'returned', 'returned')
  return {
    ...closed,
    status: 'active',
    holderCarverId: carverId,
    holderCarverName: carverName,
    claimedAt,
    expiresAt,
    releasedAt: null,
    history: [...closed.history, historyEntryFor(occupation, carverId, carverName, claimedAt, expiresAt)],
  }
}

async function load(): Promise<void> {
  ensureTicker()
  await sweepExpired()
  const [records, ops] = await Promise.all([db.occupations.toArray(), db.occupationOps.toArray()])
  occupationList.set(records)
  opList.set(ops.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
}

/** 期满清扫：过期 active 牌撤下名单，版片状态不动（仍算在刻） */
async function sweepExpired(at: number = Date.now()): Promise<number> {
  const stale = await db.occupations.where('status').equals('active').toArray()
  const expired = stale.filter(
    (occupation) => !occupation.expiresAt || new Date(occupation.expiresAt).getTime() <= at,
  )
  if (expired.length === 0) return 0

  await db.transaction('rw', db.occupations, db.carvers, async () => {
    const endedAt = new Date(at).toISOString()
    for (const occupation of expired) {
      await db.occupations.put(closeOccupation(occupation, endedAt, 'expired', 'expired'))
    }
    await rebuildRosters()
  })
  return expired.length
}

/** 名单以 active 牌为唯一事实来源，重建刻工 activeBlockIds */
async function rebuildRosters(tx?: {
  occupations: typeof db.occupations
  carvers: typeof db.carvers
}): Promise<void> {
  const scope = tx ?? { occupations: db.occupations, carvers: db.carvers }
  const [occupations, carvers] = await Promise.all([
    scope.occupations.where('status').equals('active').toArray(),
    scope.carvers.toArray(),
  ])
  const roster = new Map<string, string[]>()
  for (const occupation of occupations) {
    if (occupation.holderCarverId) {
      roster.set(occupation.holderCarverId, [...(roster.get(occupation.holderCarverId) ?? []), occupation.blockId])
    }
  }
  for (const carver of carvers) {
    const next = roster.get(carver.id) ?? []
    const current = carver.activeBlockIds
    const sameLength = next.length === current.length
    const sameMembers = sameLength && next.every((id) => current.includes(id))
    if (!sameMembers) await scope.carvers.update(carver.id, { activeBlockIds: next })
  }
}

export class OccupationConflictError extends Error {
  constructor(public holderName: string) {
    super(`这块版正由${holderName}占用`)
    this.name = 'OccupationConflictError'
  }
}

export interface ClaimResult {
  ok: boolean
  reason?: 'not-carving-state' | 'missing-carver' | 'conflict' | 'interrupted'
  holderName?: string
  operationId?: string
}

/**
 * 测试/演示用故障开关：置位后下一次领用主事务会主动 abort，
 * 用来验证「中途写入失败后恢复原占用与草稿，重开后可继续」。
 */
let faultOnNextClaim = false
export function armClaimFaultForTest(): void {
  faultOnNextClaim = true
}

async function claim(block: Block, carverId: string, draft: OccupationOperation['draft'] = {}): Promise<ClaimResult> {
  const carver = await db.carvers.get(carverId)
  if (!carver) return { ok: false, reason: 'missing-carver' }
  if (block.state === '已刻成' || block.state === '已修版') return { ok: false, reason: 'not-carving-state' }

  const [existingOccupation, carversBefore] = await Promise.all([
    db.occupations.get(block.id),
    db.carvers.toArray(),
  ])
  const rosterBefore = Object.fromEntries(carversBefore.map((item) => [item.id, [...item.activeBlockIds]]))

  const now = new Date()
  const operation: OccupationOperation = {
    id: `op-${crypto.randomUUID()}`,
    blockId: block.id,
    draftId: block.draftId,
    kind: 'claim',
    status: 'pending',
    carverId: carver.id,
    carverName: carver.name,
    createdAt: now.toISOString(),
    finishedAt: null,
    resolvedAt: null,
    resolution: null,
    errorNote: '',
    draft,
    snapshot: {
      occupation: existingOccupation ? structuredClone(existingOccupation) : null,
      blockState: block.state,
      carvedBy: block.carvedBy,
      roster: rosterBefore,
    },
  }

  // 意向先落盘（独立事务），保证关页/崩溃后重开有据可查
  await db.occupationOps.put(operation)

  try {
    const claimedAtIso = now.toISOString()
    const expiresAtIso = new Date(now.getTime() + OCCUPATION_TTL_MS).toISOString()
    await db.transaction('rw', db.occupations, db.blocks, db.carvers, async () => {
      const currentOccupation = await db.occupations.get(block.id)
      if (isActiveOccupation(currentOccupation)) {
        if (currentOccupation!.holderCarverId === carver.id) {
          // 同一刻工续领，换发新牌
          await db.occupations.put(
            renewOccupation(currentOccupation!, carver.id, carver.name, claimedAtIso, expiresAtIso),
          )
        } else {
          throw new OccupationConflictError(currentOccupation!.holderCarverName ?? '另一位刻工')
        }
      } else if (currentOccupation) {
        // 已过期/已交回，下一位重新领：旧牌与历史原样留档，追加一条新牌记录
        const nextEntry = historyEntryFor(currentOccupation, carver.id, carver.name, claimedAtIso, expiresAtIso)
        await db.occupations.put({
          ...currentOccupation,
          status: 'active',
          holderCarverId: carver.id,
          holderCarverName: carver.name,
          claimedAt: claimedAtIso,
          expiresAt: expiresAtIso,
          releasedAt: null,
          history: [...currentOccupation.history, nextEntry],
        })
      } else {
        await db.occupations.put(freshOccupation(block.id, carver.id, carver.name, claimedAtIso, expiresAtIso))
      }

      await db.blocks.update(block.id, {
        carvedBy: carver.name,
        // 领用时版片转入在刻
        state: '在刻',
      })
      await rebuildRosters()

      if (faultOnNextClaim) {
        faultOnNextClaim = false
        throw new Error('故障注入：领用写入中途失败')
      }
    })

    await db.occupationOps.update(operation.id, { status: 'done', finishedAt: new Date().toISOString() })
    await load()
    return { ok: true, operationId: operation.id }
  } catch (error) {
    if (error instanceof OccupationConflictError) {
      // 并发落败不是中断：销掉意向，避免重开后误报「可继续」
      await db.occupationOps.update(operation.id, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        resolution: 'cancelled',
        errorNote: error.message,
      })
      await load()
      return { ok: false, reason: 'conflict', holderName: error.holderName, operationId: operation.id }
    }
    // 其余异常：主事务已整体回滚，牌、版、名单维持 snapshot 原样；意向保留并标 interrupted
    await db.occupationOps.update(operation.id, {
      status: 'interrupted',
      finishedAt: new Date().toISOString(),
      errorNote: error instanceof Error ? error.message : String(error),
    })
    await load()
    return { ok: false, reason: 'interrupted', operationId: operation.id }
  }
}

async function createReturnIntent(
  block: Block,
  carverId: string,
  carverName: string,
): Promise<OccupationOperation> {
  const [existingOccupation, carversBefore] = await Promise.all([
    db.occupations.get(block.id),
    db.carvers.toArray(),
  ])
  const operation: OccupationOperation = {
    id: `op-${crypto.randomUUID()}`,
    blockId: block.id,
    draftId: block.draftId,
    kind: 'return',
    status: 'pending',
    carverId,
    carverName,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    resolvedAt: null,
    resolution: null,
    errorNote: '',
    draft: {},
    snapshot: {
      occupation: existingOccupation ? structuredClone(existingOccupation) : null,
      blockState: block.state,
      carvedBy: block.carvedBy,
      roster: Object.fromEntries(carversBefore.map((item) => [item.id, [...item.activeBlockIds]])),
    },
  }
  await db.occupationOps.put(operation)
  return operation
}

/** 交回版片：名单撤下，版片仍算在刻，下一位可以重新领 */
async function returnBlock(block: Block): Promise<ClaimResult> {
  const existingOccupation = await db.occupations.get(block.id)
  if (!isActiveOccupation(existingOccupation)) return { ok: true }

  const operation = await createReturnIntent(
    block,
    existingOccupation!.holderCarverId ?? '',
    existingOccupation!.holderCarverName ?? '',
  )
  try {
    await db.transaction('rw', db.occupations, db.carvers, async () => {
      const current = await db.occupations.get(block.id)
      if (isActiveOccupation(current)) {
        await db.occupations.put(closeOccupation(current!, new Date().toISOString(), 'returned', 'returned'))
      }
      await rebuildRosters()
    })
    await db.occupationOps.update(operation.id, { status: 'done', finishedAt: new Date().toISOString() })
    await load()
    return { ok: true, operationId: operation.id }
  } catch (error) {
    await db.occupationOps.update(operation.id, {
      status: 'interrupted',
      finishedAt: new Date().toISOString(),
      errorNote: error instanceof Error ? error.message : String(error),
    })
    await load()
    return { ok: false, reason: 'interrupted', operationId: operation.id }
  }
}

/** 验线刻成：牌随刻成交回，版片状态置为已刻成 */
async function completeBlock(block: Block): Promise<ClaimResult> {
  const existingOccupation = await db.occupations.get(block.id)
  if (!isActiveOccupation(existingOccupation)) {
    await db.blocks.update(block.id, { state: '已刻成' })
    await load()
    return { ok: true }
  }

  const operation = await createReturnIntent(
    block,
    existingOccupation!.holderCarverId ?? '',
    existingOccupation!.holderCarverName ?? '',
  )
  try {
    await db.transaction('rw', db.occupations, db.blocks, db.carvers, async () => {
      const current = await db.occupations.get(block.id)
      if (isActiveOccupation(current)) {
        await db.occupations.put(closeOccupation(current!, new Date().toISOString(), 'returned', 'returned'))
      }
      await db.blocks.update(block.id, { state: '已刻成' })
      await rebuildRosters()
    })
    await db.occupationOps.update(operation.id, { status: 'done', finishedAt: new Date().toISOString() })
    await load()
    return { ok: true, operationId: operation.id }
  } catch (error) {
    await db.occupationOps.update(operation.id, {
      status: 'interrupted',
      finishedAt: new Date().toISOString(),
      errorNote: error instanceof Error ? error.message : String(error),
    })
    await load()
    return { ok: false, reason: 'interrupted', operationId: operation.id }
  }
}

export interface RecoveredItem {
  operation: OccupationOperation
  /** applied：崩溃前主事务已提交，已自动确认；needs-attention：主事务未生效，需用户继续或放弃 */
  outcome: 'applied' | 'needs-attention'
  message: string
}

/**
 * 重开恢复：清扫期满牌、对账中断意向。
 * - pending/claim 且牌确实已是该刻工持有 → 视为已提交，补记 done（applied）；
 * - 其余 claim → 恢复 snapshot 的原占用/原版字段/原名单，意向留 interrupted 等用户选择；
 * - pending/return 且牌已关闭 → applied；牌仍 active → 重新执行交回。
 */
async function recoverInterrupted(): Promise<RecoveredItem[]> {
  const results: RecoveredItem[] = []
  await sweepExpired()

  const pending = await db.occupationOps.where('status').equals('pending').toArray()
  for (const operation of pending) {
    const [block, currentOccupation] = await Promise.all([
      db.blocks.get(operation.blockId),
      db.occupations.get(operation.blockId),
    ])

    if (operation.kind === 'claim') {
      // 以操作创建之后的领用历史判断主事务当时是否其实已提交，
      // 或者已有更新的合法领用，避免用旧快照覆盖后来的状态。
      const laterClaims = (currentOccupation?.history ?? []).filter(
        (entry) => entry.kind === 'claim' && entry.claimedAt && entry.claimedAt >= operation.createdAt,
      )
      const ownLaterClaim = laterClaims.some((entry) => entry.carverId === operation.carverId)
      const foreignLaterClaim = laterClaims.some((entry) => entry.carverId !== operation.carverId)

      if (ownLaterClaim) {
        // 主事务已提交（可能随后又交回/刻成）：确认，不回滚
        await db.occupationOps.update(operation.id, {
          status: 'done',
          finishedAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
          resolution: 'applied',
        })
        results.push({ operation, outcome: 'applied', message: `${operation.carverName}的领用在关闭前已生效，已确认原占用。` })
        continue
      }

      if (foreignLaterClaim) {
        // 已有更新的合法领用，旧意向作废，绝不能覆盖新牌
        await db.occupationOps.update(operation.id, {
          status: 'cancelled',
          resolvedAt: new Date().toISOString(),
          resolution: 'superseded',
          errorNote: '恢复时发现已有更新的合法领用，原意向作废。',
        })
        results.push({ operation: { ...operation, status: 'cancelled', resolution: 'superseded' }, outcome: 'applied', message: '该版已有新的领用，旧的中断意向自动作废。' })
        continue
      }

      // 主事务未生效：恢复原占用、原版字段与原名单
      await db.transaction('rw', db.occupations, db.blocks, db.carvers, async () => {
        if (operation.snapshot.occupation) {
          await db.occupations.put(structuredClone(operation.snapshot.occupation))
        } else {
          await db.occupations.delete(operation.blockId)
        }
        if (block) {
          await db.blocks.update(operation.blockId, {
            state: operation.snapshot.blockState,
            carvedBy: operation.snapshot.carvedBy,
          })
        }
        for (const [carverId, blockIds] of Object.entries(operation.snapshot.roster)) {
          await db.carvers.update(carverId, { activeBlockIds: blockIds })
        }
        await rebuildRosters()
      })
      await db.occupationOps.update(operation.id, {
        status: 'interrupted',
        resolvedAt: new Date().toISOString(),
        resolution: 'restored',
        errorNote: '关闭前领用写入未完成，已恢复原占用；操作草稿保留，可继续领用或放弃。',
      })
      results.push({
        operation: { ...operation, status: 'interrupted', resolution: 'restored' },
        outcome: 'needs-attention',
        message: `${block?.blockName ?? '该版片'}的领用在写入中途中断，已恢复原占用，草稿仍在。`,
      })
      continue
    }

    // return
    if (isActiveOccupation(currentOccupation)) {
      await db.transaction('rw', db.occupations, db.carvers, async () => {
        await db.occupations.put(closeOccupation(currentOccupation!, new Date().toISOString(), 'returned', 'returned'))
        await rebuildRosters()
      })
      await db.occupationOps.update(operation.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        resolution: 'applied',
      })
      results.push({ operation, outcome: 'applied', message: '关闭前未完成的交回已补做。' })
    } else {
      await db.occupationOps.update(operation.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        resolution: 'applied',
      })
      results.push({ operation, outcome: 'applied', message: '交回在关闭前已生效，已确认。' })
    }
  }

  // 已 interrupted 的意向同样提示给用户，草稿保留
  const interrupted = await db.occupationOps.where('status').equals('interrupted').toArray()
  for (const operation of interrupted) {
    if (results.some((item) => item.operation.id === operation.id)) continue
    const block = await db.blocks.get(operation.blockId)
    results.push({
      operation,
      outcome: 'needs-attention',
      message: `${block?.blockName ?? '该版片'}有一次未完成的${operation.kind === 'claim' ? '领用' : '交回'}，草稿仍在。`,
    })
  }

  await load()
  return results
}

/** 继续一次中断的领用（沿用原意向里的操作草稿） */
async function continueClaim(operationId: string): Promise<ClaimResult> {
  const operation = await db.occupationOps.get(operationId)
  const block = operation ? await db.blocks.get(operation.blockId) : undefined
  if (!operation || !block) return { ok: false, reason: 'interrupted' }
  await resolveOperation(operationId, 'retried')
  return claim(block, operation.carverId, operation.draft)
}

async function resolveOperation(
  operationId: string,
  resolution: 'cancelled' | 'retried',
): Promise<void> {
  await db.occupationOps.update(operationId, {
    status: 'cancelled',
    resolvedAt: new Date().toISOString(),
    resolution,
  })
  await load()
}

/** 放弃中断的领用草稿：原占用此前已恢复，这里只销掉意向 */
async function abandonOperation(operationId: string): Promise<void> {
  await resolveOperation(operationId, 'cancelled')
}

function isOccupiedBy(blockId: string, carverId: string): boolean {
  const occupation = get(occupationByBlock).get(blockId)
  return Boolean(occupation && isActiveOccupation(occupation) && occupation.holderCarverId === carverId)
}

export const occupationStore = {
  subscribe: occupationList.subscribe,
  operations: { subscribe: opList.subscribe },
  byBlock: { subscribe: occupationByBlock.subscribe },
  nowTick,
  load,
  sweepExpired,
  reconcileRosters: () => db.transaction('rw', db.occupations, db.carvers, rebuildRosters),
  claim,
  returnBlock,
  completeBlock,
  recoverInterrupted,
  continueClaim,
  abandonOperation,
  isOccupiedBy,
}
