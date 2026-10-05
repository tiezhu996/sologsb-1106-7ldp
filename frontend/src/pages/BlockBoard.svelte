<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { get } from 'svelte/store'
  import { link, params } from 'svelte-spa-router'
  import ColorSwatch from '../components/common/ColorSwatch.svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import SeqInput from '../components/common/SeqInput.svelte'
  import StageRail from '../components/common/StageRail.svelte'
  import { blockStore } from '../stores/blockStore'
  import { carverStore } from '../stores/carverStore'
  import { draftStore } from '../stores/draftStore'
  import { occupationStore, occupationByBlock, occupationOperations, nowTick } from '../stores/occupationStore'
  import { useBlockOrder } from '../hooks/useBlockOrder'
  import { useCarverLoad } from '../hooks/useCarverLoad'
  import { validateColorSequence } from '../utils/seq'
  import { isActiveOccupation, formatRemaining, formatClockTime } from '../utils/occupation'
  import {
    loadWorkbenchDraft,
    saveWorkbenchDraft,
    flushWorkbenchDraft,
  } from '../utils/workbenchDraft'
  import { db } from '../utils/db'
  import type { Block } from '../types/block'
  import type { OccupationRecord, OccupationOperation } from '../types/occupation'
  import type { ProcessStage } from '../types/node'

  const draftId = $derived($params?.id ?? '')
  const {
    blocks: orderedBlocks,
    carvedRate: blockCarvedRate,
    reorder: reorderBlocks,
    setDraft: setBlockDraft,
  } = useBlockOrder(draftId)
  const { activeCount: selectedActiveCount, averageDuration: selectedAverageDuration, refresh: refreshCarverLoad } = useCarverLoad('')

  let sequenceDraft = $state<Record<string, number>>({})
  let defectDraft = $state<Record<string, string>>({})
  let selectedCarverId = $state('')
  /** 每行单独选择要领用的刻工，不直接改动版片归属 */
  let claimChoice = $state<Record<string, string>>({})
  let notice = $state('')
  let lastSync = $state('刚刚')
  let draftHydrated = false
  const recoveredItems = $state<Array<{ operation: OccupationOperation; message: string }>>([])

  const draft = $derived($draftStore.find((item) => item.id === draftId) ?? null)
  const now = $derived($nowTick)

  function occupationOf(blockId: string): OccupationRecord | undefined {
    return get(occupationByBlock).get(blockId)
  }

  function activeOccupationOf(blockId: string): OccupationRecord | null {
    const occupation = occupationOf(blockId)
    return occupation && isActiveOccupation(occupation, now) ? occupation : null
  }

  /** 本行下拉默认选中：占牌人，其次刻工档第一人；纯读，初始化在 $effect 中做 */
  function defaultCarverFor(block: Block): string {
    return claimChoice[block.id] ?? $carverStore[0]?.id ?? ''
  }

  function chooseClaimCarver(block: Block, event: Event): void {
    const select = event.currentTarget as HTMLSelectElement
    claimChoice[block.id] = select.value
  }

  /** 关页后需用户定夺的中断操作（已撤销/已重试的不再提示） */
  const pendingRecoveries = $derived(
    recoveredItems
      .map((item) => ({ ...item, operation: findOp(item.operation.id) ?? item.operation }))
      .filter((item) => item.operation.status === 'interrupted' && item.operation.kind === 'claim'),
  )

  function findOp(operationId: string): OccupationOperation | undefined {
    return get(occupationOperations).find((operation) => operation.id === operationId)
  }

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), carverStore.load(), occupationStore.load()]).then(async () => {
      // 恢复工台操作草稿
      const saved = await loadWorkbenchDraft(draftId)
      if (saved) {
        sequenceDraft = { ...saved.sequenceDraft }
        defectDraft = { ...saved.defectDraft }
      }
      draftHydrated = true
      await collectRecoveries()
    })

    const flushOnHide = (): void => {
      if (document.visibilityState === 'hidden') {
        void flushWorkbenchDraft(draftId, { sequenceDraft, defectDraft })
      }
    }
    const flushOnUnload = (): void => {
      void flushWorkbenchDraft(draftId, { sequenceDraft, defectDraft })
    }
    document.addEventListener('visibilitychange', flushOnHide)
    window.addEventListener('beforeunload', flushOnUnload)

    return () => {
      document.removeEventListener('visibilitychange', flushOnHide)
      window.removeEventListener('beforeunload', flushOnUnload)
      void flushWorkbenchDraft(draftId, { sequenceDraft, defectDraft })
    }
  })

  async function collectRecoveries(): Promise<void> {
    const items = get(occupationOperations)
      .filter((operation) => operation.draftId === draftId && operation.status === 'interrupted' && operation.kind === 'claim')
      .map((operation) => {
        const block = get(blockStore).find((item) => item.id === operation.blockId)
        return {
          operation,
          message: `${block?.blockName ?? '版片'}的领用在写入中途中断，已恢复原占用，操作草稿仍在。`,
        }
      })
    recoveredItems.splice(0, recoveredItems.length, ...items)
  }

  $effect(() => {
    setBlockDraft(draftId)
  })

  // 序号/崩口草稿：先以档案为初始值，恢复草稿到达后不覆盖
  $effect(() => {
    for (const block of $orderedBlocks) {
      if (sequenceDraft[block.id] === undefined) sequenceDraft[block.id] = block.colorNo
      if (defectDraft[block.id] === undefined) defectDraft[block.id] = block.defectNote
      if (!claimChoice[block.id]) {
        claimChoice[block.id] = activeOccupationOf(block.id)?.holderCarverId ?? $carverStore[0]?.id ?? ''
      }
    }
  })

  // 草稿去抖落盘（含被故障注入中断、重开后可继续的操作草稿）
  $effect(() => {
    const snapshot = {
      sequenceDraft: structuredClone(sequenceDraft),
      defectDraft: structuredClone(defectDraft),
    }
    if (!draftHydrated) return
    saveWorkbenchDraft(draftId, snapshot)
  })

  $effect(() => {
    const firstCarver = $carverStore[0]
    if (!selectedCarverId && firstCarver) {
      selectedCarverId = firstCarver.id
      void refreshCarverLoad(firstCarver.id)
    }
  })

  function blockStateStage(state: Block['state']): number {
    if (state === '待刻' || state === '在刻') return 3
    return 4
  }

  function occupiedNumbers(exceptId: string): number[] {
    return $orderedBlocks.filter((block) => block.id !== exceptId).map((block) => block.colorNo)
  }

  async function claimBlock(block: Block): Promise<void> {
    const carverId = claimChoice[block.id] ?? defaultCarverFor(block)
    if (!carverId) {
      notice = '请先选择要领用版片的刻工。'
      return
    }
    // 领用前先把操作草稿落盘，确保中断重开后能继续
    await flushWorkbenchDraft(draftId, { sequenceDraft, defectDraft })
    const result = await occupationStore.claim(block, carverId, {
      sequenceDraft: structuredClone(sequenceDraft),
      defectDraft: structuredClone(defectDraft),
    })
    await Promise.all([blockStore.load(), carverStore.load()])
    if (result.ok) {
      claimChoice[block.id] = carverId
      notice = ''
      lastSync = `已发两小时占用牌，${block.blockName}转入在刻`
    } else if (result.reason === 'conflict') {
      notice = `${block.blockName}正由${result.holderName ?? '另一位刻工'}占用，一块版同时只认一张牌。`
    } else if (result.reason === 'not-carving-state') {
      notice = `${block.blockName}已完成刻制，不再领用。`
    } else {
      notice = `${block.blockName}领用写入中途失败，原占用未改动；可在上方提示处继续或放弃。`
      await collectRecoveries()
    }
  }

  async function returnBlock(block: Block): Promise<void> {
    const result = await occupationStore.returnBlock(block)
    await Promise.all([blockStore.load(), carverStore.load()])
    notice = result.ok ? '' : `${block.blockName}交回失败，请重试。`
    lastSync = result.ok ? `${block.blockName}已交回，版片仍算在刻，下一位可重新领` : lastSync
  }

  async function continueClaim(operationId: string): Promise<void> {
    await flushWorkbenchDraft(draftId, { sequenceDraft, defectDraft })
    const operation = findOp(operationId)
    const result = await occupationStore.continueClaim(operationId)
    if (operation?.draft.sequenceDraft) sequenceDraft = { ...operation.draft.sequenceDraft }
    if (operation?.draft.defectDraft) defectDraft = { ...operation.draft.defectDraft }
    await Promise.all([blockStore.load(), carverStore.load(), collectRecoveries()])
    notice = result.ok ? '已按保留的草稿继续完成领用。' : '继续领用未成功，原占用保持不变。'
    lastSync = result.ok ? '中断领用已继续完成' : lastSync
  }

  async function abandonClaim(operationId: string): Promise<void> {
    await occupationStore.abandonOperation(operationId)
    await collectRecoveries()
    notice = '已放弃这次中断的领用，原占用保持不变。'
  }

  async function markCarved(block: Block): Promise<void> {
    const result = await occupationStore.completeBlock(block)
    await Promise.all([blockStore.load(), carverStore.load()])
    if (!result.ok) {
      notice = `${block.blockName}刻成登记写入失败，请重试。`
      return
    }

    const currentBlocks = get(blockStore).filter((item) => item.draftId === draftId)
    const allCarved = currentBlocks.every((item) => item.state === '已刻成' || item.state === '已修版')
    await draftStore.update(draftId, { status: allCarved ? '可印' : '刻版中' })

    const existing = await db.nodes.where('blockId').equals(block.id).toArray()
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      stage: '刻版',
      seq: Math.max(0, ...existing.map((node) => node.seq)) + 1,
      operator: block.carvedBy || '当班刻工',
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: 0,
      note: '版片验线后标记刻成，占用牌随刻成交回。',
    })
    lastSync = `${block.blockName}已标记刻成，占用牌交回`
  }

  async function saveSequence(block: Block): Promise<void> {
    const next = sequenceDraft[block.id] ?? block.colorNo
    const check = validateColorSequence([...occupiedNumbers(block.id), next])
    if (!check.valid) {
      notice = check.duplicates.length
        ? `色序 ${check.duplicates.join('、')} 已占用，请调换后再存。`
        : `当前色序有跳号，缺少 ${check.gaps.join('、')}。`
      return
    }

    await blockStore.update(block.id, { colorNo: next })
    notice = `${block.blockName}色序已改为 ${next}`
    lastSync = '套色序号已存档'
    await tick()
  }

  async function moveBlock(block: Block, direction: -1 | 1): Promise<void> {
    const ordered = [...$orderedBlocks]
    const index = ordered.findIndex((item) => item.id === block.id)
    const target = ordered[index + direction]
    if (index < 0 || !target) return

    const moved = [...ordered]
    moved[index] = target
    moved[index + direction] = block
    await reorderBlocks(moved.map((item, itemIndex) => ({ id: item.id, colorNo: itemIndex + 1 })))
    moved.forEach((item, itemIndex) => {
      sequenceDraft[item.id] = itemIndex + 1
    })
    lastSync = `${block.blockName}已${direction < 0 ? '前移' : '后移'}`
  }

  async function saveDefect(block: Block): Promise<void> {
    await blockStore.update(block.id, { defectNote: defectDraft[block.id] ?? '' })
    lastSync = `${block.blockName}崩口记录已更新`
  }

  async function returnToStage(_index: number, stage: ProcessStage): Promise<void> {
    const block = $orderedBlocks[0]
    if (!block) return
    if (stage === '刻版' || stage === '修版') {
      await blockStore.update(block.id, { state: stage === '修版' ? '已修版' : '在刻' })
      lastSync = `已将首块版片阶段调至${stage}`
    }
  }

  function chooseCarver(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement
    selectedCarverId = select.value
    void refreshCarverLoad(select.value)
  }
</script>

<svelte:head>
  <title>版片编排台 · 木版年画刻版工序档案</title>
</svelte:head>

{#if !draft}
  <div class="page-heading">
    <div><p class="eyebrow">画稿与分版</p><h1>版片编排台</h1><p>正在读取画稿与版片档案。</p></div>
  </div>
  <EmptyBox title="未找到这张画稿" message="画稿可能尚未载入或档案编号有误。" />
  <a class="button secondary" use:link href="/drafts">返回画稿总览</a>
{:else}
  <div class="page-heading">
    <div>
      <p class="eyebrow">{draft.genre} · {draft.designer}</p>
      <h1>{draft.title}版片编排台</h1>
      <p>{draft.sizeCm} · 按套色序号依次刻制，先墨线后套色。</p>
    </div>
    <a class="button ghost" use:link href="/drafts">返回画稿总览</a>
  </div>

  <section class="summary-strip four">
    <div><span>版片总数</span><strong>{$orderedBlocks.length}</strong></div>
    <div><span>刻成率</span><strong>{$blockCarvedRate}%</strong></div>
    <div><span>在刻版片</span><strong>{$orderedBlocks.filter((block) => block.state === '在刻').length}</strong></div>
    <div><span>需修版片</span><strong>{$orderedBlocks.filter((block) => block.defectNote).length}</strong></div>
  </section>

  {#if pendingRecoveries.length > 0}
    <section class="panel recovery-panel" data-testid="recovery-banner">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">中断恢复</span>
          <h2>检测到写入中途关闭的领用</h2>
        </div>
      </div>
      {#each pendingRecoveries as item (item.operation.id)}
        <div class="recovery-row" data-testid={`recovery-${item.operation.id}`}>
          <p>{item.message}</p>
          <small>原占用、版片状态与刻工名单已恢复；序号、崩口等操作草稿已保留，可继续领用或放弃。</small>
          <div class="recovery-actions">
            <button class="button primary" type="button" data-testid={`continue-claim-${item.operation.id}`} onclick={() => continueClaim(item.operation.id)}>
              按草稿继续领用
            </button>
            <button class="button ghost" type="button" data-testid={`abandon-claim-${item.operation.id}`} onclick={() => abandonClaim(item.operation.id)}>
              放弃草稿
            </button>
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <div class="workbench-grid">
    <section class="panel table-panel wide-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">套色序列</span>
          <h2>版片刻制编排</h2>
        </div>
        <span class="sync-note">{lastSync}</span>
      </div>

      {#if $orderedBlocks.length === 0}
        <EmptyBox title="尚未分版" message="先回画稿总览建立画稿，系统会生成四块基础版片。" />
      {:else}
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>色序</th>
                <th>版片</th>
                <th>木料 / 版厚</th>
                <th>领用占用牌（两小时）</th>
                <th>状态</th>
                <th>崩口与修补</th>
              </tr>
            </thead>
            <tbody>
              {#each $orderedBlocks as block, blockIndex (block.id)}
                {@const active = activeOccupationOf(block.id)}
                <tr data-testid="row-block">
                  <td class="sequence-cell">
                    {#if sequenceDraft[block.id] !== undefined}
                      <SeqInput
                        bind:value={sequenceDraft[block.id]}
                        existing={occupiedNumbers(block.id)}
                        label="序号"
                        testid={`field-colorNo-${block.id}`}
                      />
                    {/if}
                    <button class="mini-button" type="button" onclick={() => saveSequence(block)}>存序号</button>
                    <div class="order-buttons">
                      <button type="button" disabled={blockIndex === 0} onclick={() => moveBlock(block, -1)}>上移</button>
                      <button type="button" disabled={blockIndex === $orderedBlocks.length - 1} onclick={() => moveBlock(block, 1)}>下移</button>
                    </div>
                  </td>
                  <td>
                    <ColorSwatch colorNo={block.colorNo} blockName={block.blockName} />
                  </td>
                  <td>
                    <strong>{block.woodType}</strong>
                    <small>{block.thicknessMm} mm</small>
                  </td>
                  <td class="claim-cell" data-testid={`claim-cell-${block.id}`}>
                    {#if block.state === '已刻成' || block.state === '已修版'}
                      <span class="tag state-{block.state}">已完成</span>
                      {#if block.carvedBy}<small>刻工：{block.carvedBy}</small>{/if}
                    {:else if active}
                      <div class="token-card held" data-testid={`token-held-${block.id}`}>
                        <span class="token-holder">{active.holderCarverName} 占用中</span>
                        <small data-testid={`token-expiry-${block.id}`}>
                          {formatRemaining(active.expiresAt, now)} · 至 {formatClockTime(active.expiresAt)}
                        </small>
                        <button class="mini-button" type="button" onclick={() => returnBlock(block)}>交回</button>
                      </div>
                    {:else}
                      <div class="token-card free" data-testid={`token-free-${block.id}`}>
                        {#if occupationOf(block.id)?.history.length}
                          {@const last = occupationOf(block.id)}
                          <small class="token-history">
                            {#if last?.history[last.history.length - 1]?.kind === 'legacy'}
                              旧档刻工：{block.carvedBy || '—'}
                            {:else}
                              上一手：{(last?.holderCarverName ?? block.carvedBy) || '—'} · 期满可重领
                            {/if}
                          </small>
                        {/if}
                        <select
                          data-testid={`field-claimCarver-${block.id}`}
                          value={defaultCarverFor(block)}
                          onchange={(event) => chooseClaimCarver(block, event)}
                        >
                          {#each $carverStore as carver}
                            <option value={carver.id}>{carver.name} · {carver.specialty}</option>
                          {/each}
                        </select>
                        <button class="mini-button strong" type="button" data-testid={`claim-${block.id}`} onclick={() => claimBlock(block)}>领用</button>
                      </div>
                    {/if}
                  </td>
                  <td>
                    <span class="tag state-{block.state}">{block.state}</span>
                    {#if block.state !== '已刻成' && block.state !== '已修版'}
                      <button class="mini-button strong" type="button" onclick={() => markCarved(block)}>标刻成</button>
                    {/if}
                  </td>
                  <td>
                    <textarea
                      data-testid={`field-defectNote-${block.id}`}
                      rows="2"
                      bind:value={defectDraft[block.id]}
                      placeholder="崩口、补线或嵌木说明"
                    ></textarea>
                    <button class="mini-button" type="button" onclick={() => saveDefect(block)}>存记录</button>
                  </td>
                </tr>
                <tr class="stage-row">
                  <td colspan="6">
                    <StageRail
                      activeIndex={blockStateStage(block.state)}
                      completedCount={block.state === '已刻成' || block.state === '已修版' ? 5 : block.state === '在刻' ? 3 : 1}
                      compact={true}
                      onselect={block.id === $orderedBlocks[0]?.id ? returnToStage : undefined}
                    />
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <aside class="panel side-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">当班安排</span>
          <h2>刻工负荷</h2>
        </div>
      </div>
      <label class="stacked-field">
        <span>选择刻工</span>
        <select value={selectedCarverId} onchange={chooseCarver}>
          {#each $carverStore as carver}<option value={carver.id}>{carver.name} · {carver.specialty}</option>{/each}
        </select>
      </label>
      <div class="load-card">
        <span>当前在刻（有效占用牌）</span>
        <strong>{$selectedActiveCount}</strong>
        <small>块</small>
      </div>
      <div class="load-card muted">
        <span>节点平均耗时</span>
        <strong>{$selectedAverageDuration}</strong>
        <small>分钟</small>
      </div>
      {#if notice}<p class="notice" data-testid="board-notice">{notice}</p>{/if}
      <a class="button secondary full" use:link href="/carvers">查看刻工档与分布</a>
    </aside>
  </div>
{/if}
