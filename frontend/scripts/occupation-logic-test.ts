import 'fake-indexeddb/auto'
import { db, initializeDatabase } from '../src/utils/db'
import { occupationStore } from '../src/stores/occupationStore'
import { blockStore } from '../src/stores/blockStore'
import { carverStore } from '../src/stores/carverStore'
import { isActiveOccupation } from '../src/utils/occupation'

let failures = 0
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function snapshot(): Promise<{ holders: Record<string, string[]>; blocks: Record<string, unknown> }> {
  const [carvers, blocks] = await Promise.all([db.carvers.toArray(), db.blocks.toArray()])
  const holders: Record<string, string[]> = {}
  for (const carver of carvers) holders[carver.name] = carver.activeBlockIds
  const blockState: Record<string, unknown> = {}
  for (const block of blocks) blockState[block.id] = { state: block.state, carvedBy: block.carvedBy }
  return { holders, blocks: blockState }
}

async function main(): Promise<void> {
  // 1. 全新库 + 旧档兼容
  console.log('[1] 种子数据：旧版片补历史占用，不算新领取')
  await initializeDatabase()
  // 额外造一块无署名版片，验证不补历史占用
  await db.blocks.add({
    id: 'block-new-no-name',
    draftId: 'draft-menshen-qin',
    blockName: '红版',
    colorNo: 9,
    woodType: '梨木',
    thicknessMm: 20,
    carvedBy: '',
    state: '待刻',
    defectNote: '',
  })
  await occupationStore.load()
  const legacy = await db.occupations.get('block-ms-02')
  assert(!!legacy, '已署名旧版片（在刻·黄版）补有占用档案')
  assert(legacy!.status === 'expired', '在刻旧版片补为 expired 历史占用')
  assert(legacy!.history[0]?.kind === 'legacy', '历史条目标记为 legacy')
  assert(legacy!.holderCarverId === null, '历史占用无持有人、不发新牌')
  const legacyDone = await db.occupations.get('block-ms-01')
  assert(legacyDone!.status === 'returned', '已刻成旧版片补为 returned 历史占用')
  const noNameBlock = await db.occupations.get('block-new-no-name')
  assert(!noNameBlock, '无署名版片不补占用')
  await carverStore.load()
  const carverZhou = await db.carvers.get('carver-zhou')
  assert(carverZhou!.activeBlockIds.length === 0, '旧档当班名单全部清空，不背历史负担')

  // 2. 领用：发牌、转在刻、负担增加
  console.log('[2] 领用占用牌')
  await blockStore.load()
  const targetBlock = (await db.blocks.get('block-ms-03'))!
  const before = await snapshot()
  const claimResult = await occupationStore.claim(targetBlock, 'carver-chen')
  assert(claimResult.ok, '陈小满领用红版成功')
  const afterClaim = await db.occupations.get('block-ms-03')
  assert(isActiveOccupation(afterClaim), '占用牌处于 active 且两小时内有效')
  const ttlMs = new Date(afterClaim!.expiresAt!).getTime() - new Date(afterClaim!.claimedAt!).getTime()
  assert(ttlMs === 2 * 60 * 60 * 1000, '有效期恰好两小时')
  const claimedBlock = await db.blocks.get('block-ms-03')
  assert(claimedBlock!.state === '在刻', '领用时版片转入在刻')
  assert(claimedBlock!.carvedBy === '陈小满', '版片署名更新为领用人')
  const carverChen = await db.carvers.get('carver-chen')
  assert(carverChen!.activeBlockIds.includes('block-ms-03'), '刻工当班名单负担 +1')

  // 3. 并发：另一个刻工同时领同一块
  console.log('[3] 两个窗口同时保存领用，一块版只认一张牌')
  const sameBlock = (await db.blocks.get('block-ms-03'))!
  const conflict = await occupationStore.claim(sameBlock, 'carver-zhou')
  assert(!conflict.ok && conflict.reason === 'conflict', '第二人领用被拒（conflict）')
  assert(conflict.holderName === '陈小满', '拒绝原因指明当前占牌人')
  const stillOne = (await db.occupations.where('status').equals('active').toArray()).filter(
    (o) => o.blockId === 'block-ms-03',
  )
  assert(stillOne.length === 1, '该版仍只有一张 active 牌')
  const zhouRoster = (await db.carvers.get('carver-zhou'))!.activeBlockIds
  assert(!zhouRoster.includes('block-ms-03'), '未把版片挂到第二个人名下')

  // 4. 同一刻工续领：换发新牌
  console.log('[4] 同一刻工续领')
  const renew = await occupationStore.claim(sameBlock, 'carver-chen')
  assert(renew.ok, '同一刻工续领成功')
  const renewed = await db.occupations.get('block-ms-03')
  const claimEntries = renewed!.history.filter((h) => h.kind === 'claim')
  assert(claimEntries.length === 2, '旧牌闭合入历史，新牌另起一条（共两次 claim 记录）')
  assert(renewed!.holderCarverId === 'carver-chen', '续领后持有人不变')

  // 5. 交回：名单撤下、版仍在刻、下一位可重新领
  console.log('[5] 交回与重新领用')
  await occupationStore.returnBlock(await db.blocks.get('block-ms-03')!)
  const returned = await db.occupations.get('block-ms-03')
  assert(returned!.status === 'returned' && returned!.holderCarverId === null, '交回后牌关闭、名单撤下')
  const returnedBlock = await db.blocks.get('block-ms-03')
  assert(returnedBlock!.state === '在刻', '交回后版片仍算在刻')
  assert(!(await db.carvers.get('carver-chen'))!.activeBlockIds.includes('block-ms-03'), '交回后刻工负担 -1')
  const nextClaim = await occupationStore.claim(await db.blocks.get('block-ms-03')!, 'carver-zhou')
  assert(nextClaim.ok, '下一位可重新领')
  const nextOcc = await db.occupations.get('block-ms-03')
  assert(nextOcc!.holderCarverId === 'carver-zhou' && nextOcc!.status === 'active', '新牌挂到周桂枝名下')

  // 6. 期满
  console.log('[6] 两小时期满自动撤牌')
  const farPast = new Date(Date.now() + 3 * 60 * 60 * 1000).getTime()
  const swept = await occupationStore.sweepExpired(farPast)
  assert(swept >= 1, '清扫到至少一张期满牌')
  const expired = await db.occupations.get('block-ms-03')
  assert(expired!.status === 'expired' && expired!.holderCarverId === null, '期满牌关闭、名单撤下')
  assert((await db.blocks.get('block-ms-03'))!.state === '在刻', '期满后版片仍算在刻')
  assert(!(await db.carvers.get('carver-zhou'))!.activeBlockIds.includes('block-ms-03'), '期满后名单不再挂版')

  // 7. 故障注入：主事务中途失败 → 意向 interrupted → 重开恢复 → 继续
  console.log('[7] 中途写入失败后的恢复')
  const freshBlock = (await db.blocks.get('block-ms-04'))! // 待刻
  assert(freshBlock.state === '待刻', '前置：绿版当前待刻')
  const { armClaimFaultForTest } = await import('../src/stores/occupationStore')
  armClaimFaultForTest()
  const failed = await occupationStore.claim(freshBlock, 'carver-qin', {
    sequenceDraft: { 'block-ms-04': 9 },
    defectDraft: { 'block-ms-04': '中断前草稿' },
  })
  assert(!failed.ok && failed.reason === 'interrupted', '故障注入：领用主事务失败')
  assert((await db.blocks.get('block-ms-04'))!.state === '待刻', '事务回滚：版片状态恢复原样')
  assert((await db.blocks.get('block-ms-04'))!.carvedBy === '秦木生', '事务回滚：署名维持旧档（旧版有署名）')
  assert(!(await db.carvers.get('carver-qin'))!.activeBlockIds.includes('block-ms-04'), '事务回滚：名单未挂版')
  const interruptedOp = await db.occupationOps.get(failed.operationId!)
  assert(interruptedOp!.status === 'interrupted', '操作意向保留为 interrupted，草稿在内')
  assert(interruptedOp!.draft.defectDraft?.['block-ms-04'] === '中断前草稿', '意向内嵌操作草稿完好')

  // 模拟重开：recoverInterrupted 应保持恢复态（snapshot 原本就无牌）
  const recovered = await occupationStore.recoverInterrupted()
  const related = recovered.filter((r) => r.operation.blockId === 'block-ms-04')
  assert(related.length === 1 && related[0]!.outcome === 'needs-attention', '重开后该意向需用户定夺并提示')
  assert((await db.blocks.get('block-ms-04'))!.state === '待刻', '恢复后版片仍是原状态')

  // 选择「继续」：沿用草稿完成领用
  const continued = await occupationStore.continueClaim(failed.operationId!)
  assert(continued.ok, '按保留草稿继续领用成功')
  const continuedOcc = await db.occupations.get('block-ms-04')
  assert(isActiveOccupation(continuedOcc) && continuedOcc!.holderCarverId === 'carver-qin', '继续后绿版由秦木生占用')
  assert((await db.blocks.get('block-ms-04'))!.state === '在刻', '继续后版片转入在刻')

  // 8. 崩溃在「意向已写、主事务已提交、状态未标 done」之间：重开应自动确认
  console.log('[8] 崩溃于提交后、确认前：自动确认不重复领用')
  const target2 = (await db.blocks.get('block-mk-02'))! // 待刻
  // 手工构造一次「已生效但意向仍 pending」的场景
  const claim2 = await occupationStore.claim(target2, 'carver-chen')
  assert(claim2.ok, '第二次领用先成功')
  await db.occupationOps.update(claim2.operationId!, { status: 'pending', resolution: null })
  const recovered2 = await occupationStore.recoverInterrupted()
  const autoApplied = recovered2.find((r) => r.operation.id === claim2.operationId)
  assert(autoApplied?.outcome === 'applied', '检测到牌已生效，自动确认原占用（applied）')
  const opAfter = await db.occupationOps.get(claim2.operationId!)
  assert(opAfter!.status === 'done' && opAfter!.resolution === 'applied', '意向补记 done/applied')
  assert((await db.carvers.get('carver-chen'))!.activeBlockIds.filter((id) => id === 'block-mk-02').length === 1, '未重复挂名单')

  // 9. 刻成：牌交回 + 已刻成
  console.log('[9] 标刻成即交回')
  await occupationStore.completeBlock(await db.blocks.get('block-ms-04')!)
  const doneOcc = await db.occupations.get('block-ms-04')
  assert(doneOcc!.status === 'returned', '刻成后牌交回关闭')
  assert((await db.blocks.get('block-ms-04'))!.state === '已刻成', '版片刻成')
  assert(!(await db.carvers.get('carver-qin'))!.activeBlockIds.includes('block-ms-04'), '刻成后名单撤下')

  const finalSnapshot = await snapshot()
  console.log('[终态]', JSON.stringify(finalSnapshot, null, 1))
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  await sleep(10)
  void db.close()
  if (failures > 0) process.exitCode = 1
}

void main()
