import type { BlockState } from './block'

/**
 * 占用牌状态：
 * - active   牌在有效期内，一块版同时只允许一张 active 牌
 * - expired  两小时期满，名单已撤，版片仍算「在刻」，下一位可重新领
 * - returned 刻工主动交回（含版片刻成交回），名单已撤
 */
export type OccupationStatus = 'active' | 'expired' | 'returned'

export type OccupationHistoryKind = 'claim' | 'legacy'
export type OccupationEndReason = 'returned' | 'expired' | 'legacy'

export interface OccupationHistoryEntry {
  seq: number
  kind: OccupationHistoryKind
  carverId: string
  carverName: string
  claimedAt: string | null
  expiresAt: string | null
  endedAt: string | null
  endReason: OccupationEndReason | null
  note: string
}

export interface OccupationRecord {
  /** 一块版一行，主键即 blockId，从结构上保证一版至多一张牌 */
  blockId: string
  status: OccupationStatus
  holderCarverId: string | null
  holderCarverName: string | null
  claimedAt: string | null
  expiresAt: string | null
  releasedAt: string | null
  history: OccupationHistoryEntry[]
}

export type OccupationOpKind = 'claim' | 'return'
export type OccupationOpStatus = 'pending' | 'done' | 'interrupted' | 'cancelled'
export type OccupationOpResolution = 'applied' | 'restored' | 'superseded' | 'retried' | 'cancelled'

export interface OccupationOpDraft {
  sequenceDraft?: Record<string, number>
  defectDraft?: Record<string, string>
}

/**
 * 写操作落盘前先写一条 pending 意向：
 * - 主事务提交后标记 done；
 * - 主事务报错时事务整体回滚，意向转 interrupted 供页面提示；
 * - 关页/崩溃导致意向停在 pending 时，重开后按 snapshot 对账恢复。
 */
export interface OccupationOperation {
  id: string
  blockId: string
  draftId: string
  kind: OccupationOpKind
  status: OccupationOpStatus
  carverId: string
  carverName: string
  createdAt: string
  finishedAt: string | null
  resolvedAt: string | null
  resolution: OccupationOpResolution | null
  errorNote: string
  draft: OccupationOpDraft
  snapshot: {
    occupation: OccupationRecord | null
    blockState: BlockState
    carvedBy: string
    roster: Record<string, string[]>
  }
}

export interface WorkbenchDraft {
  draftId: string
  sequenceDraft: Record<string, number>
  defectDraft: Record<string, string>
  updatedAt: string
}
