import type { WorkbenchDraft } from '../types/occupation'
import { db } from './db'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const SAVE_DEBOUNCE_MS = 400

export async function loadWorkbenchDraft(
  draftId: string,
): Promise<Pick<WorkbenchDraft, 'sequenceDraft' | 'defectDraft'> | null> {
  const record = await db.workbenchDrafts.get(draftId)
  if (!record) return null
  return { sequenceDraft: record.sequenceDraft, defectDraft: record.defectDraft }
}

/** 去抖落盘；关页前再 flushWorkbenchDraft 兜底 */
export function saveWorkbenchDraft(
  draftId: string,
  draft: Pick<WorkbenchDraft, 'sequenceDraft' | 'defectDraft'>,
): void {
  const timer = saveTimers.get(draftId)
  if (timer) clearTimeout(timer)
  saveTimers.set(
    draftId,
    setTimeout(() => {
      void persistWorkbenchDraft(draftId, draft)
    }, SAVE_DEBOUNCE_MS),
  )
}

export async function flushWorkbenchDraft(
  draftId: string,
  draft: Pick<WorkbenchDraft, 'sequenceDraft' | 'defectDraft'>,
): Promise<void> {
  const timer = saveTimers.get(draftId)
  if (timer) {
    clearTimeout(timer)
    saveTimers.delete(draftId)
  }
  await persistWorkbenchDraft(draftId, draft)
}

export async function clearWorkbenchDraft(draftId: string): Promise<void> {
  const timer = saveTimers.get(draftId)
  if (timer) {
    clearTimeout(timer)
    saveTimers.delete(draftId)
  }
  await db.workbenchDrafts.delete(draftId)
}

async function persistWorkbenchDraft(
  draftId: string,
  draft: Pick<WorkbenchDraft, 'sequenceDraft' | 'defectDraft'>,
): Promise<void> {
  const record: WorkbenchDraft = {
    draftId,
    sequenceDraft: draft.sequenceDraft,
    defectDraft: draft.defectDraft,
    updatedAt: new Date().toISOString(),
  }
  await db.workbenchDrafts.put(record)
}
