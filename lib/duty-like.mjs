/**
 * 点赞预算：把「每日点赞总数上限」算成每轮实际可点的数量。
 *
 * 背景：B站 直播间点赞（likeReportV3）虽然按房间下发的批次/间隔限速，
 * 但长时间挂机时每轮都会点满，单日累计点击数可能上千，容易被风控。
 * 这里按北京时间自然日（与 state.json 的每日重置一致）做**全局**上限：
 * 所有房间当天已点次数合计，达到上限后当天不再点赞。
 *
 * @param {{ spent?: number, dailyMax?: number, roundClicks?: number }} [opts]
 *   spent       当天已成功点赞次数（所有房间合计）
 *   dailyMax    每日总上限
 *   roundClicks 本轮计划点击数（还会被房间策略再切批）
 * @returns {{ used:number, max:number, remain:number, clicks:number, exhausted:boolean }}
 */
export function likeBudget({ spent = 0, dailyMax = 600, roundClicks = 300 } = {}) {
  const used = Math.max(0, Math.floor(Number(spent) || 0))
  const max = Math.max(1, Math.floor(Number(dailyMax) || 600))
  const round = Math.max(0, Math.floor(Number(roundClicks) || 0))
  const remain = Math.max(0, max - used)
  return {
    used,
    max,
    remain,
    clicks: Math.min(round, remain),
    exhausted: remain === 0,
  }
}
