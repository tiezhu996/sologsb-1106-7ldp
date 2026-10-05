import type { OccupationRecord } from '../types/occupation'

/** 占用牌有效期：两小时 */
export const OCCUPATION_TTL_MS = 2 * 60 * 60 * 1000

export function isActiveOccupation(occupation: OccupationRecord | undefined | null, at: number = Date.now()): boolean {
  return Boolean(
    occupation &&
      occupation.status === 'active' &&
      occupation.expiresAt &&
      new Date(occupation.expiresAt).getTime() > at,
  )
}

/** 占用剩余时间（分钟），已过期为 0 */
export function remainingMinutes(expiresAt: string | null, at: number = Date.now()): number {
  if (!expiresAt) return 0
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - at) / 60000))
}

export function formatRemaining(expiresAt: string | null, at: number = Date.now()): string {
  const minutes = remainingMinutes(expiresAt, at)
  if (minutes <= 0) return '刚过期'
  if (minutes < 60) return `剩余 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `剩余 ${hours} 小时` : `剩余 ${hours} 小时 ${rest} 分`
}

export function formatClockTime(value: string | null): string {
  if (!value) return ''
  return value.slice(0, 16).replace('T', ' ')
}

export function activeCarverIds(occupations: OccupationRecord[], at: number = Date.now()): string[] {
  const ids = new Set<string>()
  for (const occupation of occupations) {
    if (isActiveOccupation(occupation, at) && occupation.holderCarverId) ids.add(occupation.holderCarverId)
  }
  return [...ids]
}
