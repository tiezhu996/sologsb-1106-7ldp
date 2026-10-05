import { writable } from 'svelte/store'
import type { Carver } from '../types/carver'
import { db } from '../utils/db'

const carverList = writable<Carver[]>([])
const blockAssignments = writable<Record<string, string[]>>({})

function syncAssignments(records: Carver[]): void {
  const assignments: Record<string, string[]> = {}
  for (const carver of records) assignments[carver.id] = [...carver.activeBlockIds]
  blockAssignments.set(assignments)
}

async function load(): Promise<void> {
  const records = await db.carvers.toArray()
  records.sort((a, b) => a.specialty.localeCompare(b.specialty, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
  carverList.set(records)
  syncAssignments(records)
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

export const carverStore = {
  subscribe: carverList.subscribe,
  assignments: { subscribe: blockAssignments.subscribe },
  load,
  create,
  update,
}
