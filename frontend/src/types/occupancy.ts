import type { BlockState } from './block'

export type OccupancyKind = '领取' | '历史补录'
export type OccupancyStatus = '生效中' | '已交回' | '已期满'

export interface BlockOccupancy {
  id: string
  blockId: string
  carverId: string
  carverName: string
  kind: OccupancyKind
  status: OccupancyStatus
  claimedAt: string
  /** null 表示长期有效（历史补录的旧版片） */
  expiresAt: string | null
  releasedAt: string | null
  schemaRev?: number
}

export type ClaimOpKind = '领取' | '交回'
export type ClaimOpStatus = '进行中' | '已完成' | '待恢复' | '已恢复'

export interface ClaimOpSnapshot {
  /** 操作前该版片的生效占用 */
  occupancies: BlockOccupancy[]
  block: { carvedBy: string; state: BlockState } | null
  /** 相关刻工操作前的在刻名单 */
  carverBlockIds: Record<string, string[]>
}

export interface ClaimOp {
  id: string
  kind: ClaimOpKind
  blockId: string
  carverId: string
  carverName: string
  occupancyId: string | null
  status: ClaimOpStatus
  error: string
  snapshot: ClaimOpSnapshot
  startedAt: string
  finishedAt: string | null
  schemaRev?: number
}
