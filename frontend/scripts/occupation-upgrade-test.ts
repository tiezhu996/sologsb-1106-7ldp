import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db } from '../src/utils/db'

let failures = 0
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

/**
 * 先按旧结构（schema v2）建库并放入「旧世界」数据：
 * 周桂枝名下挂着两块在刻版（activeBlockIds），所有版片都有 carvedBy 署名。
 * 再用当前代码打开库，触发 version(3) 升级，验证兼容补登。
 */
class LegacyDb extends Dexie {
  constructor() {
    super('gbwoodprint-db')
    this.version(1).stores({
      drafts: 'id, genre, status, title',
      blocks: 'id, draftId, colorNo, carvedBy, state',
      carvers: 'id, specialty, skillLevel, name',
      batches: 'id, draftId, batchNo, printedAt',
      nodes: 'id, batchId, blockId, stage, seq, operator',
    })
    this.version(2).stores({
      drafts: 'id, genre, status, title, schemaRev',
      blocks: 'id, draftId, colorNo, carvedBy, state, schemaRev',
      carvers: 'id, specialty, skillLevel, name, schemaRev',
      batches: 'id, draftId, batchNo, printedAt, schemaRev',
      nodes: 'id, batchId, blockId, stage, seq, operator, schemaRev',
    })
  }
}

async function main(): Promise<void> {
  console.log('[升级] v2 旧库 → v3')
  const legacy = new LegacyDb()
  await legacy.open()
  await legacy.table('blocks').bulkAdd([
    { id: 'b1', draftId: 'd1', blockName: '墨线版', colorNo: 1, woodType: '黄杨', thicknessMm: 18, carvedBy: '周桂枝', state: '在刻', defectNote: '', schemaRev: 2 },
    { id: 'b2', draftId: 'd1', blockName: '黄版', colorNo: 2, woodType: '梨木', thicknessMm: 20, carvedBy: '齐师傅', state: '已刻成', defectNote: '', schemaRev: 2 },
    { id: 'b3', draftId: 'd1', blockName: '红版', colorNo: 3, woodType: '梨木', thicknessMm: 20, carvedBy: '', state: '待刻', defectNote: '', schemaRev: 2 },
  ])
  await legacy.table('carvers').bulkAdd([
    { id: 'c1', name: '周桂枝', specialty: '套色', skillLevel: '熟练', activeBlockIds: ['b1'], pieceworkNote: '', schemaRev: 2 },
    { id: 'c2', name: '齐师傅', specialty: '墨线', skillLevel: '师傅', activeBlockIds: [], pieceworkNote: '', schemaRev: 2 },
  ])
  await legacy.close()

  await db.open()

  const legacyRows = await db.occupations.toArray()
  assert(legacyRows.length === 2, '两块有署名旧版片补了历史占用（无署名的 b3 不补）')
  const b1 = await db.occupations.get('b1')
  assert(b1!.status === 'expired' && b1!.holderCarverId === null, '在刻旧版：expired 关闭态，不发新牌')
  assert(b1!.history[0]?.kind === 'legacy' && b1!.history[0]?.carverId === 'c1', '历史条目关联到旧刻工档案')
  const b2 = await db.occupations.get('b2')
  assert(b2!.status === 'returned', '已完成旧版：returned 历史占用')

  const zhou = await db.carvers.get('c1')
  assert(zhou!.activeBlockIds.length === 0, '升级后旧 activeBlockIds 当班名单撤空（不算新领取）')
  const blockB1 = await db.blocks.get('b1')
  assert(blockB1!.state === '在刻' && blockB1!.carvedBy === '周桂枝', '版片状态与署名原样保留')
  assert(blockB1!.schemaRev === 3, 'schemaRev 回填到 3')

  // 升级后的库可以正常走新领用
  const claim = await db.occupations.get('b3')
  assert(!claim, 'b3 升级后无占用牌')
  db.close()
  console.log(failures === 0 ? '\n升级测试全部通过 ✅' : `\n${failures} 项失败 ❌`)
  if (failures > 0) process.exitCode = 1
}

void main()
