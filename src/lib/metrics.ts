import "server-only";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { formatCurrency, formatCurrencyCompact, formatPercent } from "@/lib/utils";
import { Store } from "@/models/Store";
import { Workspace } from "@/models/Workspace";
import { Order } from "@/models/Order";
import { Payout } from "@/models/Payout";
import { netRevenueSumExpr, orderNetRevenue } from "@/lib/order-revenue";
import {
  netRevenueSumBaseExpr,
  shippingSumBaseExpr,
  feesSumBaseExpr,
  cogsSumBaseExpr,
  orderModeCogsSumExpr,
  cogsSumExprForMode,
  orderCogsBase,
} from "@/lib/order-money";
import {
  aggregateDailyRefundsIssued,
  aggregateRefundsIssuedByStore,
  mergeDailyAggWithRefundIssuance,
  sumRefundsIssuedInPeriod,
  type DailyOrderAgg,
} from "@/lib/order-refunds";
import {
  mergePaidOrderFilter,
} from "@/lib/order-financial-status";
import {
  sumManualCogsForPeriod,
  sumManualCogsByDay,
  countOrdersMissingManualCogs,
  countMissingCogsDays,
  countMissingCogsForStores,
  formatMissingCogsWarning,
} from "@/lib/manual-cogs";
import {
  sumEuCategoryFeesForPeriod,
  sumEuCategoryFeesByDay,
  appliesEuCategoryFees,
} from "@/lib/eu-category-fees";
import { appliesAutoEuCustomsFees } from "@/lib/cogs-modes";
import {
  aggregateStoreAdInsightsForPeriod,
  type StoreAdInsights,
} from "@/lib/ad-insights";
import {
  sumAdSpendForPeriod,
  buildStoreAdSpendSummaries,
  aggregateAdSpendForStores,
} from "@/lib/ad-spend";
import { countSoldVariantsMissingCost, countMissingCogsByDay } from "@/lib/cogs";
import { ranksProductsByUnits, isCogsMode, type CogsMode } from "@/lib/cogs-modes";
import { ManualAdSpend } from "@/models/ManualAdSpend";
import { DailyMetric } from "@/models/DailyMetric";
import {
  resolvePeriodForStore,
  orderDateMatchInTimezone,
  normalizeStoreTimezone,
  dayKeysBetweenInTimezone,
  importDateKey,
  dateKeyInTimezone,
  zonedStartOfDay,
  zonedEndOfDay,
  DEFAULT_STORE_TIMEZONE,
} from "@/lib/store-timezone";
import {
  canAccessStore,
  type StoreAccess,
} from "@/lib/store-access";
import { NON_ARCHIVED_STORE_FILTER } from "@/lib/store-scope";
import type { CollectionReminder } from "@/lib/collection-schedule";
import { listCollectionRemindersForWorkspace } from "@/lib/collection-operations";
import {
  clipSliceForKilledStore,
  countKilledExcludedFromPeriod,
  filterStoresForFinancialMetrics,
  operationExclusionNote,
  resolveStoreOperationStatus,
  storesForFinancialConsolidated,
} from "@/lib/operation-filters";
import {
  aggregateAdSpendWithKillClip,
  aggregateStoreAggsWithKillClip,
} from "@/lib/operation-metrics";
import {
  orderDateMatch,
  periodDayCount,
  periodIsSingleDay,
  formatDateInput,
  formatDateKeyLabel,
  parseDateInput,
  addDays,
  startOfDay,
  endOfDay,
  clampSliceToImportFloor,
  earliestImportFloor,
  resolveImportFloor,
  type PeriodInput,
  type ResolvedPeriod,
} from "@/lib/period";
import {
  fetchStoreDailyNotesForPeriod,
  fetchWorkspaceDailyNotesForPeriod,
  type StoreDailyNoteView,
} from "@/lib/daily-notes";
import {
  aggregateSessionFunnelFromDb,
  loadDailySessionCountsForSlice,
  loadDailySessionCountsByCountryForSlice,
  type SessionFunnelMetrics,
} from "@/lib/session-metrics";
import {
  sessionCountryKeysFromStore,
  sessionCountryLabel,
} from "@/lib/shopify-countries";
import { getStoreDisplayUrl } from "@/lib/store-display";
import { resolveLastSyncedAtForStoreIds } from "@/lib/last-sync-at";
import {
  calcNetProfit,
  contributionMarginPct,
  storeBerRoas,
  fmtBerRoas,
  calcPoas,
  fmtPoas,
  formatProfitBreakdown,
} from "@/lib/profit";
import {
  sumChargebacksByStore,
  sumChargebacksForStoreDay,
  sumChargebacksByDayKey,
} from "@/lib/dispute-cost";
import { buildStoreColorMap } from "@/lib/store-colors";
import {
  sumOperatingExpensesByStore,
  sumOperatingExpensesForPeriod,
  loadWorkspaceExpensesLean,
  sumLoadedExpenses,
  sumLoadedExpensesForDay,
  sumLoadedExpensesByStore,
  sumWorkspaceExpensesForDay,
  type ExpenseLeanRow,
} from "@/lib/expenses";
import {
  classifyProfitWindow,
  isDateKeyConsolidated,
  profitWindowNote,
  type ProfitWindowStatus,
} from "@/lib/profit-window";
import { buildMonthlyGoalsProgress } from "@/lib/monthly-goals";

export type KpiIcon = "euro" | "percent" | "target" | "trending";

export type SummaryKpi = {
  label: string;
  value: string;
  /** Valor exato (tooltip) quando `value` está em notação compacta. */
  title?: string;
  delta?: number;
  /** Texto após o delta, ex. "vs 1–30 Abr 2025" */
  deltaLabel?: string;
  /** true = pontos percentuais (pp), false = % relativa */
  deltaIsPoints?: boolean;
  trend?: number[];
  icon?: KpiIcon;
  /** BER: queda no valor é positiva para o negócio */
  deltaInverted?: boolean;
};

export type CostBreakdownItem = {
  key: string;
  label: string;
  value: number;
  valueFmt: string;
  /** Informativo (não soma ao total de custos, ex. refunds já na REV líquida). */
  informative?: boolean;
};

export type CostBreakdown = {
  totalCosts: number;
  totalCostsFmt: string;
  revenue: number;
  revenueFmt: string;
  netProfit: number;
  netProfitFmt: string;
  items: CostBreakdownItem[];
  adSpendKnown: boolean;
};

export type SummaryStore = {
  storeId: string;
  name: string;
  color: string;
  revenue: string;
  profit: string;
  margin: string;
  adSpend: string;
  roas: string;
  positive: boolean;
  trend: number[];
  sort: {
    revenue: number;
    profit: number;
    margin: number;
    adSpend: number;
    roas: number | null;
  };
};

export type TopProduct = {
  title: string;
  units: number;
  revenue: string;
  profit: string;
  margin: string;
  berRoas: string;
  positive: boolean;
  marginPositive: boolean;
};

export type WaterfallStep = {
  key: string;
  label: string;
  value: number;
  display: string;
  type: "start" | "negative" | "total";
};

export type StorePayoutPreview = {
  amount: number;
  amountFmt: string;
  nextDate: string | null;
  nextDateLabel: string | null;
};

export type StoreDashboardData = {
  waterfall: WaterfallStep[];
  payout: StorePayoutPreview;
  periodLabel: string;
  prevPeriodLabel: string;
  periodIsSingleDay: boolean;
  dailyNotes: StoreDailyNoteView[];
  funnelKpis: SummaryKpi[];
  funnelError?: string;
  sessionCountryLabel: string;
  lastSessionMetricsError?: string | null;
};

export type ProfitChartStoreSlice = {
  storeId: string;
  name: string;
  color: string;
  profit: number;
  profitFmt: string;
  revenue: number;
  revenueFmt: string;
};

export type ProfitChartSeries = {
  storeId: string;
  name: string;
  color: string;
  /** Chave numérica de lucro em cada ponto (Recharts). */
  key: string;
  /** Chave numérica de faturação em cada ponto (Recharts). */
  revenueKey: string;
};

export type ProfitChartPoint = {
  dateKey: string;
  label: string;
  dateLabel: string;
  profit: number | null;
  profitFmt: string;
  revenue: number | null;
  revenueFmt: string;
  hasNote?: boolean;
  notePreview?: string;
  didScale?: boolean;
  /** Lucro/faturação por loja (vista consolidada). */
  byStore?: ProfitChartStoreSlice[];
  /** true = dia fora da janela de refunds (consolidado). */
  consolidated?: boolean;
};

/** Linha da tabela diária (métricas por dia — página /metricas). */
export type StoreDailyMetricRow = {
  dateKey: string;
  dateLabel: string;
  revenue: string;
  cogs: string;
  refunds: string;
  adSpend: string;
  profit: string;
  profitPositive: boolean;
  /** Tooltip com breakdown REV − custos − ads. */
  profitTitle?: string;
  /** Encomendas neste dia (0 = sem vendas). */
  ordersCount?: number;
  sessions: number | null;
  atcPct: string;
  checkoutPct: string;
  cvrPct: string;
  /** Há nota diária (texto, scale ou humor) neste dia. */
  hasNote?: boolean;
  notePreview?: string;
};

export type DashboardSummary = {
  kpis: SummaryKpi[];
  stores: SummaryStore[];
  /** Nome da loja quando a vista está filtrada por uma só loja. */
  scopeName: string | null;
  /** Domínio da loja (ex. marie-bruxelles.com) para o título. */
  scopeDomain: string | null;
  /** Top produtos (só na vista de uma loja). */
  topProducts: TopProduct[];
  /** Ranking por lucro ou por unidades (modos COGS por encomenda/dia). */
  topProductsMode: "profit" | "units";
  /** Dados extra da dashboard por loja (waterfall, payout). */
  storeDashboard: StoreDashboardData | null;
  /** Notas diárias (vista por loja). */
  dailyNotes: StoreDailyNoteView[];
  /** Produtos vendidos sem COGS — lucro pode estar incompleto. */
  cogsIncomplete: boolean;
  missingCogsCount: number;
  /** Texto do aviso de COGS (respeita modo por loja). */
  missingCogsMessage: string;
  /** Dias de ad spend em falta (desde importação até ontem). */
  missingAdSpendDays: number;
  /** Série diária de lucro (vista consolidada). */
  profitChart: ProfitChartPoint[];
  /** Metadados das linhas por loja (consolidado, 2+ lojas). */
  profitChartSeries?: ProfitChartSeries[];
  /** Métricas dia a dia (vista por loja). */
  dailyMetrics: StoreDailyMetricRow[];
  /** Métricas extra (custos, funil, encomendas…) — painel «Ver mais». */
  extendedKpis: SummaryKpi[];
  /** Repartição de custos do período (painel lateral da dashboard). */
  costBreakdown: CostBreakdown;
  /** Janela de refunds do workspace (dias). */
  refundWindowDays: number;
  /** Estado do lucro no período seleccionado. */
  profitWindowStatus: ProfitWindowStatus;
  profitWindowNote: string;
  /** ISO timestamp de quando os dados foram calculados. */
  generatedAt: string;
  /** ISO do último sync (Shopify, sessões, payouts, ads API). */
  lastSyncedAt: string | null;
  /** Metas mensais (MTD vs objectivo), se configuradas. */
  monthlyGoals: import("@/lib/monthly-goals").MonthlyGoalsProgress | null;
  /** Modo operação → impacto no financeiro (exclusões, lembretes). */
  operationContext?: {
    exclusionNote: string | null;
    excludedWaiting: number;
    excludedKilled: number;
    scopedStoreStatus: string | null;
    collectionReminders: CollectionReminder[];
  };
};

type StoreAgg = {
  revenue: number;
  cogs: number;
  shipping: number;
  fees: number;
  refunds: number;
  orders: number;
};

type StoreCogsCtx = {
  _id: mongoose.Types.ObjectId;
  cogsMode?: string | null;
  ianaTimezone?: string | null;
  cogsDayFromKey?: string | null;
  cogsModePriorToDayForce?: string | null;
};

function emptyStoreAgg(): StoreAgg {
  return {
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
    orders: 0,
  };
}

function storeCogsMode(store: StoreCogsCtx): CogsMode {
  return (store.cogsMode ?? "shopify") as CogsMode;
}

/** Agrega métricas por loja com COGS conforme o modo (shopify/variant/order/day). */
async function aggregateStoreAggs(
  wsId: mongoose.Types.ObjectId,
  stores: StoreCogsCtx[],
  slice: PeriodSlice,
  sharedTimeZone?: string | null,
): Promise<Map<string, StoreAgg>> {
  const result = new Map<string, StoreAgg>();
  if (!stores.length) return result;

  const storeOids = stores.map((s) => s._id);
  const dateMatch = sharedTimeZone
    ? orderDateMatchInTimezone(slice, sharedTimeZone)
    : orderDateMatch(slice);

  const baseRows = await Order.aggregate<
    { _id: mongoose.Types.ObjectId } & StoreAgg
  >([
    {
      $match: mergePaidOrderFilter({
        workspaceId: wsId,
        storeId: { $in: storeOids },
        ...dateMatch,
      }),
    },
    {
      $group: {
        _id: "$storeId",
        revenue: netRevenueSumBaseExpr,
        cogs: { $sum: 0 },
        shipping: shippingSumBaseExpr,
        fees: feesSumBaseExpr,
        refunds: { $sum: 0 },
        orders: { $sum: 1 },
      },
    },
  ]);

  const refundsByStore = await aggregateRefundsIssuedByStore(
    wsId,
    storeOids,
    slice,
    sharedTimeZone,
  );

  for (const r of baseRows) {
    const { _id, ...agg } = r;
    const sid = String(_id);
    const issued = refundsByStore.get(sid) ?? 0;
    result.set(sid, {
      ...agg,
      refunds: issued,
    });
  }
  for (const s of stores) {
    if (!result.has(String(s._id))) {
      const issued = refundsByStore.get(String(s._id)) ?? 0;
      if (issued > 0) {
        result.set(String(s._id), {
          ...emptyStoreAgg(),
          refunds: issued,
        });
      } else {
        result.set(String(s._id), emptyStoreAgg());
      }
    }
  }

  const shopifyVariantOids = stores
    .filter((s) => {
      const m = storeCogsMode(s);
      return m === "shopify" || m === "variant";
    })
    .map((s) => s._id);
  const orderOids = stores
    .filter((s) => storeCogsMode(s) === "order")
    .map((s) => s._id);
  const dayStores = stores.filter((s) => storeCogsMode(s) === "day");

  if (shopifyVariantOids.length) {
    const cogsRows = await Order.aggregate<{
      _id: mongoose.Types.ObjectId;
      cogs: number;
    }>([
      {
        $match: mergePaidOrderFilter({
          workspaceId: wsId,
          storeId: { $in: shopifyVariantOids },
          ...dateMatch,
        }),
      },
      { $group: { _id: "$storeId", cogs: cogsSumBaseExpr } },
    ]);
    for (const r of cogsRows) {
      result.get(String(r._id))!.cogs = r.cogs;
    }
  }

  if (orderOids.length) {
    const cogsRows = await Order.aggregate<{
      _id: mongoose.Types.ObjectId;
      cogs: number;
    }>([
      {
        $match: mergePaidOrderFilter({
          workspaceId: wsId,
          storeId: { $in: orderOids },
          ...dateMatch,
        }),
      },
      { $group: { _id: "$storeId", cogs: orderModeCogsSumExpr } },
    ]);
    for (const r of cogsRows) {
      result.get(String(r._id))!.cogs = r.cogs;
    }
  }

  await Promise.all(
    dayStores.map(async (s) => {
      const tz = normalizeStoreTimezone(s.ianaTimezone);
      const zone = sharedTimeZone ?? tz;
      const fromKey = s.cogsDayFromKey ?? null;
      const priorMode = isCogsMode(s.cogsModePriorToDayForce ?? "")
        ? (s.cogsModePriorToDayForce as CogsMode)
        : "shopify";
      const agg = result.get(String(s._id))!;

      if (!fromKey) {
        agg.cogs = await sumManualCogsForPeriod([s._id], slice, zone);
        return;
      }

      const keys = dayKeysInSlice(slice, zone);
      const beforeKeys = keys.filter((k) => k < fromKey);
      const afterKeys = keys.filter((k) => k >= fromKey);
      let cogs = 0;

      if (beforeKeys.length) {
        const beforeSlice: PeriodSlice = {
          start: slice.start,
          end: slice.end,
          specificDates: beforeKeys,
        };
        const [row] = await Order.aggregate<{ cogs: number }>([
          {
            $match: mergePaidOrderFilter({
              workspaceId: wsId,
              storeId: s._id,
              ...orderDateMatchInTimezone(beforeSlice, zone),
            }),
          },
          { $group: { _id: null, cogs: cogsSumExprForMode(priorMode) } },
        ]);
        cogs += row?.cogs ?? 0;
        if (appliesEuCategoryFees(priorMode)) {
          const euByDay = await sumEuCategoryFeesByDay(s._id, beforeKeys);
          for (const fee of euByDay.values()) cogs += fee;
        }
      }

      if (afterKeys.length) {
        cogs += await sumManualCogsForPeriod(
          [s._id],
          { start: slice.start, end: slice.end, specificDates: afterKeys },
          zone,
        );
      }

      agg.cogs = cogs;
    }),
  );

  await Promise.all(
    stores
      .filter((s) => appliesEuCategoryFees(storeCogsMode(s)))
      .map(async (s) => {
        const tz = normalizeStoreTimezone(s.ianaTimezone);
        const fees = await sumEuCategoryFeesForPeriod(
          [s._id],
          slice,
          sharedTimeZone ?? tz,
        );
        result.get(String(s._id))!.cogs += fees;
      }),
  );

  return result;
}

function calcProfit(
  a: Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees">,
  adSpend = 0,
  operatingExpenses = 0,
  chargebacks = 0,
) {
  // Portes Shopify (o que o cliente paga) são margem extra, não custo de envio ao fornecedor.
  return calcNetProfit(
    { revenue: a.revenue, cogs: a.cogs, shipping: 0, fees: a.fees },
    adSpend,
    operatingExpenses,
    chargebacks,
  );
}

/** Lucro diário = mesmo Net Profit dos KPIs (REV já é líquida de reembolsos). */
function calcDailyProfit(
  a: Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees" | "refunds">,
  adSpend = 0,
  operatingExpenses = 0,
  chargebacks = 0,
) {
  return calcProfit(a, adSpend, operatingExpenses, chargebacks);
}

/** Inputs de margem/BER: portes cobrados ao cliente não contam como custo. */
function marginInputsFromAgg(
  a: Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees">,
) {
  return { revenue: a.revenue, cogs: a.cogs, shipping: 0, fees: a.fees };
}

function resolveDailyAdSpend(
  adByDay: Map<string, number>,
  dateKey: string,
): { amount: number; hasEntry: boolean } {
  const hasEntry = adByDay.has(dateKey);
  return {
    hasEntry,
    amount: hasEntry ? adByDay.get(dateKey)! : 0,
  };
}

function formatAdSpendCell(
  hasEntry: boolean,
  amount: number,
  fmtMoney: (v: number) => string,
): string {
  return hasEntry ? fmtMoney(amount) : "—";
}

function deltaPct(current: number, prev: number) {
  if (prev === 0) return current > 0 ? 100 : 0;
  return ((current - prev) / Math.abs(prev)) * 100;
}

function fmtRoasRatio(v: number | null): string {
  return v != null ? v.toFixed(2).replace(".", ",") : "—";
}

function buildAdInsightKpis(
  cur: Pick<StoreAdInsights, "cpc" | "ctr" | "cpm"> | null,
  prev: Pick<StoreAdInsights, "cpc" | "ctr" | "cpm"> | null,
  deltaSuffix: string,
  money: (v: number) => string,
): SummaryKpi[] {
  const pctDelta = (a: number | null, b: number | null) =>
    a != null && b != null ? a - b : undefined;

  return [
    {
      label: "CPC",
      value: cur?.cpc != null ? money(cur.cpc) : "—",
      title:
        cur?.cpc == null
          ? "Liga contas de ads em Anúncios para ver CPC"
          : undefined,
      delta:
        cur?.cpc != null && prev?.cpc != null
          ? deltaPct(cur.cpc, prev.cpc)
          : undefined,
      deltaLabel: cur?.cpc != null ? deltaSuffix : undefined,
      icon: "euro",
    },
    {
      label: "CTR %",
      value: cur?.ctr != null ? formatPercent(cur.ctr) : "—",
      title:
        cur?.ctr == null
          ? "Liga contas de ads em Anúncios para ver CTR"
          : undefined,
      delta: pctDelta(cur?.ctr ?? null, prev?.ctr ?? null),
      deltaIsPoints: true,
      deltaLabel: cur?.ctr != null ? deltaSuffix : undefined,
      icon: "percent",
    },
    {
      label: "CPM",
      value: cur?.cpm != null ? money(cur.cpm) : "—",
      title:
        cur?.cpm == null
          ? "Liga contas de ads em Anúncios para ver CPM"
          : undefined,
      delta:
        cur?.cpm != null && prev?.cpm != null
          ? deltaPct(cur.cpm, prev.cpm)
          : undefined,
      deltaLabel: cur?.cpm != null ? deltaSuffix : undefined,
      icon: "euro",
    },
  ];
}

function buildExtendedStoreKpis(
  cur: StoreAgg,
  prev: StoreAgg,
  curAdSpend: number,
  prevAdSpend: number,
  curAdSpendKnown: boolean,
  prevAdSpendKnown: boolean,
  curOperatingExpenses: number,
  prevOperatingExpenses: number,
  funnelCur: SessionFunnelMetrics,
  funnelPrev: SessionFunnelMetrics | null,
  adInsightsCur: Pick<StoreAdInsights, "cpc" | "ctr" | "cpm"> | null,
  adInsightsPrev: Pick<StoreAdInsights, "cpc" | "ctr" | "cpm"> | null,
  deltaSuffix: string,
  money: (v: number) => string,
  fmtMoney: (v: number) => string,
  curChargebacks = 0,
  prevChargebacks = 0,
): SummaryKpi[] {
  const curCm = contributionMarginPct(marginInputsFromAgg(cur));
  const prevCm = contributionMarginPct(marginInputsFromAgg(prev));
  const curAov = cur.orders > 0 ? cur.revenue / cur.orders : null;
  const prevAov = prev.orders > 0 ? prev.revenue / prev.orders : null;
  const curMer =
    curAdSpendKnown && curAdSpend > 0 ? cur.revenue / curAdSpend : null;
  const prevMer =
    prevAdSpendKnown && prevAdSpend > 0 ? prev.revenue / prevAdSpend : null;
  const curProfit = calcProfit(
    cur,
    curAdSpendKnown ? curAdSpend : 0,
    curOperatingExpenses,
    curChargebacks,
  );
  const prevProfit = calcProfit(
    prev,
    prevAdSpendKnown ? prevAdSpend : 0,
    prevOperatingExpenses,
    prevChargebacks,
  );
  const curPoas =
    curAdSpendKnown && curAdSpend > 0
      ? calcPoas(curProfit, curAdSpend)
      : null;
  const prevPoas =
    prevAdSpendKnown && prevAdSpend > 0
      ? calcPoas(prevProfit, prevAdSpend)
      : null;

  const costKpis: SummaryKpi[] = [
    {
      label: "Revenue",
      value: money(cur.revenue),
      title: fmtMoney(cur.revenue),
      delta: deltaPct(cur.revenue, prev.revenue),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Margem contrib. %",
      value: formatPercent(curCm),
      title:
        "Margem antes do ad spend (REV − COGS − taxas) / REV",
      delta: curCm - prevCm,
      deltaLabel: deltaSuffix,
      deltaIsPoints: true,
      icon: "percent",
    },
    {
      label: "COGS",
      value: money(cur.cogs),
      title: fmtMoney(cur.cogs),
      delta: deltaPct(cur.cogs, prev.cogs),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Portes cobrados",
      value: money(cur.shipping),
      title:
        cur.shipping > 0
          ? `${fmtMoney(cur.shipping)} — portes pagos pelo cliente (margem extra, não custo)`
          : "Sem portes cobrados no período",
      delta: deltaPct(cur.shipping, prev.shipping),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Taxas",
      value: money(cur.fees),
      title: fmtMoney(cur.fees),
      delta: deltaPct(cur.fees, prev.fees),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Ad Spend",
      value: curAdSpendKnown ? money(curAdSpend) : "—",
      title: curAdSpendKnown
        ? fmtMoney(curAdSpend)
        : "Por preencher em Anúncios — não entra no lucro até registares",
      delta:
        curAdSpendKnown && prevAdSpendKnown
          ? deltaPct(curAdSpend, prevAdSpend)
          : undefined,
      deltaLabel: curAdSpendKnown ? deltaSuffix : undefined,
      icon: "euro",
    },
    {
      label: "Refunds",
      value: fmtMoney(cur.refunds),
      title: "Informativo — já reflectidos na REV líquida",
      delta: deltaPct(cur.refunds, prev.refunds),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Encomendas",
      value: cur.orders.toLocaleString("pt-PT"),
      delta: deltaPct(cur.orders, prev.orders),
      deltaLabel: deltaSuffix,
      icon: "trending",
    },
    {
      label: "AOV",
      value: curAov != null ? money(curAov) : "—",
      title:
        curAov != null
          ? `Valor médio por encomenda · ${fmtMoney(curAov)}`
          : undefined,
      delta:
        curAov != null && prevAov != null
          ? deltaPct(curAov, prevAov)
          : undefined,
      deltaLabel: curAov != null ? deltaSuffix : undefined,
      icon: "euro",
    },
    {
      label: "MER",
      value: fmtRoasRatio(curMer),
      title: "Marketing Efficiency Ratio = REV / ad spend",
      delta:
        curMer != null && prevMer != null
          ? deltaPct(curMer, prevMer)
          : undefined,
      deltaLabel: curMer != null ? deltaSuffix : undefined,
      icon: "target",
    },
    {
      label: "POAS",
      value: fmtPoas(curPoas),
      title: "Profit on Ad Spend = lucro líquido / ad spend",
      delta:
        curPoas != null && prevPoas != null
          ? deltaPct(curPoas, prevPoas)
          : undefined,
      deltaLabel: curPoas != null ? deltaSuffix : undefined,
      icon: "trending",
    },
  ];

  return [
    ...costKpis,
    ...buildFunnelKpis(funnelCur, funnelPrev, deltaSuffix),
    {
      label: "Despesas",
      value: money(curOperatingExpenses),
      title: fmtMoney(curOperatingExpenses),
      delta: deltaPct(curOperatingExpenses, prevOperatingExpenses),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    ...buildAdInsightKpis(adInsightsCur, adInsightsPrev, deltaSuffix, money),
  ];
}

function buildExtendedWorkspaceKpis(
  cur: StoreAgg,
  prev: StoreAgg,
  curAdSpend: number,
  prevAdSpend: number,
  curAdSpendKnown: boolean,
  prevAdSpendKnown: boolean,
  curOperatingExpenses: number,
  prevOperatingExpenses: number,
  deltaSuffix: string,
  money: (v: number) => string,
  fmtMoney: (v: number) => string,
  curChargebacks = 0,
  prevChargebacks = 0,
): SummaryKpi[] {
  const curCm = contributionMarginPct(marginInputsFromAgg(cur));
  const prevCm = contributionMarginPct(marginInputsFromAgg(prev));
  const curAov = cur.orders > 0 ? cur.revenue / cur.orders : null;
  const prevAov = prev.orders > 0 ? prev.revenue / prev.orders : null;
  const curProfit = calcProfit(
    cur,
    curAdSpendKnown ? curAdSpend : 0,
    curOperatingExpenses,
    curChargebacks,
  );
  const prevProfit = calcProfit(
    prev,
    prevAdSpendKnown ? prevAdSpend : 0,
    prevOperatingExpenses,
    prevChargebacks,
  );
  const curMer =
    curAdSpendKnown && curAdSpend > 0 ? cur.revenue / curAdSpend : null;
  const prevMer =
    prevAdSpendKnown && prevAdSpend > 0 ? prev.revenue / prevAdSpend : null;
  const curPoas =
    curAdSpendKnown && curAdSpend > 0 ? calcPoas(curProfit, curAdSpend) : null;
  const prevPoas =
    prevAdSpendKnown && prevAdSpend > 0
      ? calcPoas(prevProfit, prevAdSpend)
      : null;

  return [
    {
      label: "Margem contrib. %",
      value: formatPercent(curCm),
      title: "Margem antes do ad spend",
      delta: curCm - prevCm,
      deltaLabel: deltaSuffix,
      deltaIsPoints: true,
      icon: "percent",
    },
    {
      label: "COGS",
      value: money(cur.cogs),
      title: fmtMoney(cur.cogs),
      delta: deltaPct(cur.cogs, prev.cogs),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Portes cobrados",
      value: money(cur.shipping),
      title:
        cur.shipping > 0
          ? `${fmtMoney(cur.shipping)} — portes pagos pelo cliente (margem extra, não custo)`
          : "Sem portes cobrados no período",
      delta: deltaPct(cur.shipping, prev.shipping),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Taxas",
      value: money(cur.fees),
      title: fmtMoney(cur.fees),
      delta: deltaPct(cur.fees, prev.fees),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Refunds",
      value: fmtMoney(cur.refunds),
      title: "Informativo — já na REV líquida",
      delta: deltaPct(cur.refunds, prev.refunds),
      deltaLabel: deltaSuffix,
      icon: "euro",
    },
    {
      label: "Encomendas",
      value: cur.orders.toLocaleString("pt-PT"),
      delta: deltaPct(cur.orders, prev.orders),
      deltaLabel: deltaSuffix,
      icon: "trending",
    },
    {
      label: "AOV",
      value: curAov != null ? money(curAov) : "—",
      title: curAov != null ? fmtMoney(curAov) : undefined,
      delta:
        curAov != null && prevAov != null
          ? deltaPct(curAov, prevAov)
          : undefined,
      deltaLabel: curAov != null ? deltaSuffix : undefined,
      icon: "euro",
    },
    {
      label: "Ad Spend",
      value: curAdSpendKnown ? money(curAdSpend) : "—",
      title: curAdSpendKnown
        ? fmtMoney(curAdSpend)
        : "Por preencher em Anúncios — não entra no lucro até registares",
      delta:
        curAdSpendKnown && prevAdSpendKnown
          ? deltaPct(curAdSpend, prevAdSpend)
          : undefined,
      deltaLabel: curAdSpendKnown ? deltaSuffix : undefined,
      icon: "euro",
    },
    {
      label: "MER",
      value: fmtRoasRatio(curMer),
      title: "Marketing Efficiency Ratio = REV / ad spend",
      delta:
        curMer != null && prevMer != null
          ? deltaPct(curMer, prevMer)
          : undefined,
      deltaLabel: curMer != null ? deltaSuffix : undefined,
      icon: "target",
    },
    {
      label: "POAS",
      value: fmtPoas(curPoas),
      title: "Profit on Ad Spend = lucro líquido / ad spend",
      delta:
        curPoas != null && prevPoas != null
          ? deltaPct(curPoas, prevPoas)
          : undefined,
      deltaLabel: curPoas != null ? deltaSuffix : undefined,
      icon: "trending",
    },
  ];
}

function buildFunnelKpis(
  cur: SessionFunnelMetrics,
  prev: SessionFunnelMetrics | null,
  deltaSuffix: string,
): SummaryKpi[] {
  const sessFmt = (n: number) =>
    n.toLocaleString("pt-PT", { maximumFractionDigits: 0 });
  const pctFmt = (p: number | null) =>
    p != null ? formatPercent(p) : "—";
  const pctDelta = (a: number | null, b: number | null) =>
    a != null && b != null ? a - b : undefined;

  return [
    {
      label: "Sessões",
      value: cur.error ? "—" : sessFmt(cur.sessions),
      title: cur.error,
      delta:
        !cur.error && prev && !prev.error
          ? deltaPct(cur.sessions, prev.sessions)
          : undefined,
      deltaLabel: !cur.error && prev && !prev.error ? deltaSuffix : undefined,
      icon: "trending",
    },
    {
      label: "ATC %",
      value: pctFmt(cur.atcPct),
      delta: pctDelta(cur.atcPct, prev?.atcPct ?? null),
      deltaLabel: cur.atcPct != null ? deltaSuffix : undefined,
      deltaIsPoints: true,
      icon: "percent",
    },
    {
      label: "Checkout %",
      value: pctFmt(cur.checkoutPct),
      delta: pctDelta(cur.checkoutPct, prev?.checkoutPct ?? null),
      deltaLabel: cur.checkoutPct != null ? deltaSuffix : undefined,
      deltaIsPoints: true,
      icon: "percent",
    },
    {
      label: "CVR %",
      value: pctFmt(cur.cvrPct),
      delta: pctDelta(cur.cvrPct, prev?.cvrPct ?? null),
      deltaLabel: cur.cvrPct != null ? deltaSuffix : undefined,
      deltaIsPoints: true,
      icon: "target",
    },
  ];
}

function normPayoutStatus(s?: string | null) {
  return (s ?? "").toLowerCase();
}

type PeriodSlice = Pick<ResolvedPeriod, "start" | "end" | "specificDates">;

function missingCogsNote(count: number, mode?: CogsMode | null): string {
  if (count <= 0) return "";
  if (mode == null) {
    return `COGS em falta (${count}) neste período — lucro pode estar superestimado`;
  }
  if (mode === "day") {
    const n = count === 1 ? "dia com vendas" : "dias com vendas";
    return `COGS em falta em ${count} ${n} neste período — lucro pode estar superestimado; confirma custos diários`;
  }
  if (mode === "order") {
    const n = count === 1 ? "encomenda" : "encomendas";
    return `COGS em falta em ${count} ${n} neste período — lucro pode estar superestimado`;
  }
  const n = count === 1 ? "produto" : "produtos";
  return `COGS em falta em ${count} ${n} neste período — lucro pode estar superestimado; confirma custos do fornecedor`;
}

function adSpendDateMatch(
  slice: PeriodSlice,
  storeTimeZone?: string | null,
): Record<string, unknown> {
  if (slice.specificDates?.length) {
    return { dateKey: { $in: slice.specificDates } };
  }
  if (storeTimeZone) {
    const keys = dayKeysBetweenInTimezone(
      slice.start,
      slice.end,
      storeTimeZone,
    );
    if (!keys.length) return { dateKey: { $in: [] } };
    return { dateKey: { $gte: keys[0], $lte: keys[keys.length - 1] } };
  }
  return {
    dateKey: {
      $gte: formatDateInput(slice.start),
      $lte: formatDateInput(slice.end),
    },
  };
}

async function aggregateDailyAdSpend(
  storeOids: mongoose.Types.ObjectId[],
  slice: PeriodSlice,
  storeTimeZone?: string | null,
): Promise<Map<string, number>> {
  if (!storeOids.length) return new Map();

  const rows = await ManualAdSpend.aggregate<{ _id: string; total: number }>([
    {
      $match: {
        storeId: { $in: storeOids },
        ...adSpendDateMatch(slice, storeTimeZone),
      },
    },
    {
      $group: {
        _id: "$dateKey",
        total: {
          $sum: { $add: ["$amount", { $ifNull: ["$extraFee", 0] }] },
        },
      },
    },
  ]);

  return new Map(rows.map((r) => [r._id, r.total]));
}

async function aggregateDailyOrders(
  wsId: mongoose.Types.ObjectId,
  storeOids: mongoose.Types.ObjectId[],
  slice: PeriodSlice,
  storeTimeZone?: string | null,
  cogsMode?: CogsMode | null,
  opts?: {
    cogsDayFromKey?: string | null;
    cogsModePriorToDayForce?: CogsMode | null;
  },
): Promise<
  Map<
    string,
    Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees" | "refunds" | "orders">
  >
> {
  const match = mergePaidOrderFilter({
    workspaceId: wsId,
    ...(storeOids.length === 1
      ? { storeId: storeOids[0] }
      : storeOids.length > 1
        ? { storeId: { $in: storeOids } }
        : {}),
    ...(storeTimeZone
      ? orderDateMatchInTimezone(slice, storeTimeZone)
      : orderDateMatch(slice)),
  });

  const fromKey = opts?.cogsDayFromKey ?? null;
  const priorMode =
    (opts?.cogsModePriorToDayForce as CogsMode | null | undefined) ?? "shopify";
  const hybridDay = cogsMode === "day" && Boolean(fromKey);
  const cogsExpr = cogsSumExprForMode(hybridDay ? priorMode : cogsMode);

  const rows = await Order.aggregate<{
    _id: string;
    revenue: number;
    cogs: number;
    shipping: number;
    fees: number;
    refunds: number;
    orders: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: storeTimeZone
          ? {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$orderDate",
                timezone: normalizeStoreTimezone(storeTimeZone),
              },
            }
          : {
              $dateToString: { format: "%Y-%m-%d", date: "$orderDate" },
            },
        revenue: netRevenueSumBaseExpr,
        cogs: cogsExpr,
        shipping: shippingSumBaseExpr,
        fees: feesSumBaseExpr,
        refunds: { $sum: 0 },
        orders: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const grossByDay = new Map(
    rows.map((r) => [
      r._id,
      {
        revenue: r.revenue,
        cogs: r.cogs,
        shipping: r.shipping,
        fees: r.fees,
        refunds: 0,
        orders: r.orders,
      },
    ]),
  );

  const refundByDay = await aggregateDailyRefundsIssued(
    wsId,
    storeOids,
    slice,
    storeTimeZone,
  );
  const result = mergeDailyAggWithRefundIssuance(grossByDay, refundByDay);

  if (cogsMode === "day" && storeOids.length === 1) {
    const dayKeys = dayKeysInSlice(slice, storeTimeZone);
    const dayCogs = await sumManualCogsByDay(storeOids[0], dayKeys);
    for (const dateKey of dayKeys) {
      const data = result.get(dateKey) ?? {
        revenue: 0,
        cogs: 0,
        shipping: 0,
        fees: 0,
        refunds: 0,
        orders: 0,
      };
      if (!fromKey || dateKey >= fromKey) {
        data.cogs = dayCogs.get(dateKey) ?? 0;
      }
      result.set(dateKey, data);
    }
  }

  const euMode = hybridDay ? priorMode : cogsMode;
  if (appliesEuCategoryFees(euMode) && storeOids.length === 1) {
    const dayKeys = dayKeysInSlice(slice, storeTimeZone);
    const euFees = await sumEuCategoryFeesByDay(storeOids[0], dayKeys);
    for (const [dateKey, fee] of euFees) {
      if (fromKey && dateKey >= fromKey) continue;
      const data = result.get(dateKey);
      if (data && fee > 0) data.cogs += fee;
    }
  }

  return result;
}

function storeDayKey(dateKey: string, storeId: string) {
  return `${dateKey}:${storeId}`;
}

async function aggregateDailyOrdersByStore(
  wsId: mongoose.Types.ObjectId,
  stores: StoreCogsCtx[],
  slice: PeriodSlice,
  sharedTimeZone?: string | null,
): Promise<
  Map<string, Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees" | "refunds">>
> {
  const map = new Map<
    string,
    Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees" | "refunds">
  >();
  if (!stores.length) return map;

  const zeroRow = () => ({
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
  });

  await Promise.all(
    stores.map(async (store) => {
      const sid = String(store._id);
      const tz = sharedTimeZone ?? normalizeStoreTimezone(store.ianaTimezone);
      const mode = storeCogsMode(store);
      const fromKey = store.cogsDayFromKey ?? null;
      const priorMode = isCogsMode(store.cogsModePriorToDayForce ?? "")
        ? (store.cogsModePriorToDayForce as CogsMode)
        : "shopify";
      const hybridDay = mode === "day" && Boolean(fromKey);
      const dateExpr = {
        $dateToString: {
          format: "%Y-%m-%d",
          date: "$orderDate",
          timezone: tz,
        },
      };
      const cogsExpr = cogsSumExprForMode(hybridDay ? priorMode : mode);

      const rows = await Order.aggregate<{
        _id: string;
        revenue: number;
        cogs: number;
        shipping: number;
        fees: number;
        refunds: number;
      }>([
        {
          $match: mergePaidOrderFilter({
            workspaceId: wsId,
            storeId: store._id,
            ...orderDateMatchInTimezone(slice, tz),
          }),
        },
        {
          $group: {
            _id: dateExpr,
            revenue: netRevenueSumBaseExpr,
            cogs: cogsExpr,
            shipping: shippingSumBaseExpr,
            fees: feesSumBaseExpr,
            refunds: { $sum: 0 },
          },
        },
      ]);

      const grossByDay = new Map<
        string,
        Pick<StoreAgg, "revenue" | "cogs" | "shipping" | "fees" | "refunds"> &
          Pick<DailyOrderAgg, "orders">
      >();
      for (const r of rows) {
        grossByDay.set(r._id, {
          revenue: r.revenue,
          cogs: r.cogs,
          shipping: r.shipping,
          fees: r.fees,
          refunds: 0,
          orders: 0,
        });
      }

      const refundByDay = await aggregateDailyRefundsIssued(
        wsId,
        [store._id],
        slice,
        tz,
      );
      const merged = mergeDailyAggWithRefundIssuance(grossByDay, refundByDay);
      for (const [dateKey, row] of merged) {
        map.set(storeDayKey(dateKey, sid), row);
      }

      if (mode === "day") {
        const dayKeys = dayKeysInSlice(slice, tz);
        const dayCogs = await sumManualCogsByDay(store._id, dayKeys);
        for (const dateKey of dayKeys) {
          const key = storeDayKey(dateKey, sid);
          const row = map.get(key) ?? zeroRow();
          if (!fromKey || dateKey >= fromKey) {
            row.cogs = dayCogs.get(dateKey) ?? 0;
          }
          map.set(key, row);
        }
      }

      const euMode = hybridDay ? priorMode : mode;
      if (appliesEuCategoryFees(euMode)) {
        const dayKeys = dayKeysInSlice(slice, tz);
        const euFees = await sumEuCategoryFeesByDay(store._id, dayKeys);
        for (const [dateKey, fee] of euFees) {
          if (fee <= 0) continue;
          if (fromKey && dateKey >= fromKey) continue;
          const key = storeDayKey(dateKey, sid);
          const row = map.get(key) ?? zeroRow();
          row.cogs += fee;
          map.set(key, row);
        }
      }
    }),
  );

  return map;
}

async function aggregateDailyAdSpendByStore(
  storeOids: mongoose.Types.ObjectId[],
  slice: PeriodSlice,
  storeTimeZone?: string | null,
): Promise<Map<string, number>> {
  if (!storeOids.length) return new Map();

  const rows = await ManualAdSpend.aggregate<{
    _id: { dateKey: string; storeId: mongoose.Types.ObjectId };
    total: number;
  }>([
    {
      $match: {
        storeId: { $in: storeOids },
        ...adSpendDateMatch(slice, storeTimeZone),
      },
    },
    {
      $group: {
        _id: { dateKey: "$dateKey", storeId: "$storeId" },
        total: {
          $sum: { $add: ["$amount", { $ifNull: ["$extraFee", 0] }] },
        },
      },
    },
  ]);

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(storeDayKey(r._id.dateKey, String(r._id.storeId)), r.total);
  }
  return map;
}

async function buildConsolidatedDailyProfitSeries(
  wsId: mongoose.Types.ObjectId,
  stores: Array<{
    _id: mongoose.Types.ObjectId;
    name: string;
    importStartDate?: Date | null;
    createdAt?: Date;
    cogsMode?: string | null;
    ianaTimezone?: string | null;
    operationStatus?: string | null;
    operationKilledAt?: Date | null;
  }>,
  colorByStoreId: Map<string, string>,
  slice: PeriodSlice,
  fmtMoney: (v: number) => string,
  storeTimeZone?: string | null,
  expenseRows: ExpenseLeanRow[] = [],
): Promise<{ points: ProfitChartPoint[]; series: ProfitChartSeries[] }> {
  const series: ProfitChartSeries[] = stores.map((s) => {
    const sid = String(s._id);
    return {
      storeId: sid,
      name: s.name,
      color: colorByStoreId.get(sid) ?? "#5B5EA6",
      key: `s_${sid}`,
      revenueKey: `r_${sid}`,
    };
  });

  const storeOids = stores.map((s) => s._id);
  const [ordersByStoreDay, adByStoreDay] = await Promise.all([
    aggregateDailyOrdersByStore(wsId, stores, slice, storeTimeZone),
    aggregateDailyAdSpendByStore(storeOids, slice, storeTimeZone),
  ]);

  const zeros = {
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
  };

  const tzNorm = normalizeStoreTimezone(storeTimeZone);

  const points = dayKeysInSlice(slice, storeTimeZone).map((dateKey) => {
    const byStore: ProfitChartStoreSlice[] = [];
    let totalProfit = 0;
    let totalRevenue = 0;
    const point: ProfitChartPoint & Record<string, number | string> = {
      dateKey,
      label: "",
      dateLabel: "",
      profit: 0,
      profitFmt: "",
      revenue: 0,
      revenueFmt: "",
    };

    for (const meta of series) {
      const storeRef = stores.find((s) => String(s._id) === meta.storeId);
      if (!storeRef) continue;

      const importKey = importDateKey(
        storeRef.importStartDate,
        storeRef.createdAt,
        tzNorm,
      );
      if (importKey && dateKey < importKey) {
        point[meta.key] = null as unknown as number;
        point[meta.revenueKey] = null as unknown as number;
        continue;
      }

      if (
        resolveStoreOperationStatus(storeRef) === "killed" &&
        storeRef.operationKilledAt
      ) {
        const killKey = formatDateInput(startOfDay(storeRef.operationKilledAt));
        if (dateKey > killKey) continue;
      }
      const o =
        ordersByStoreDay.get(storeDayKey(dateKey, meta.storeId)) ?? zeros;
      const storeKey = storeDayKey(dateKey, meta.storeId);
      const hasEntry = adByStoreDay.has(storeKey);
      const ad = hasEntry ? adByStoreDay.get(storeKey)! : 0;
      const storeOpEx = sumLoadedExpensesForDay(
        expenseRows,
        dateKey,
        meta.storeId,
      );
      const profit = calcDailyProfit(o, hasEntry ? ad : 0, storeOpEx);
      const revenue = o.revenue;
      byStore.push({
        storeId: meta.storeId,
        name: meta.name,
        color: meta.color,
        profit,
        profitFmt: fmtMoney(profit),
        revenue,
        revenueFmt: fmtMoney(revenue),
      });
      point[meta.key] = profit;
      point[meta.revenueKey] = revenue;
      totalProfit += profit;
      totalRevenue += revenue;
    }

    const workspaceOpEx = sumWorkspaceExpensesForDay(expenseRows, dateKey);
    const hasActiveStore = byStore.length > 0;

    point.label = formatDateKeyLabel(dateKey);
    point.dateLabel = formatDateKeyLabel(dateKey, { withYear: true });

    if (hasActiveStore) {
      totalProfit -= workspaceOpEx;
      point.profit = totalProfit;
      point.profitFmt = fmtMoney(totalProfit);
      point.revenue = totalRevenue;
      point.revenueFmt = fmtMoney(totalRevenue);
    } else {
      point.profit = null;
      point.profitFmt = "—";
      point.revenue = null;
      point.revenueFmt = "—";
    }

    point.byStore = byStore.sort(
      (a, b) => Math.abs(b.profit) - Math.abs(a.profit),
    );
    return point;
  });

  return { points, series };
}

function dayKeysInSlice(slice: PeriodSlice, storeTimeZone?: string | null): string[] {
  if (slice.specificDates !== undefined) {
    return [...slice.specificDates].sort();
  }
  if (storeTimeZone) {
    return dayKeysBetweenInTimezone(
      slice.start,
      slice.end,
      storeTimeZone,
    );
  }
  const keys: string[] = [];
  let cur = startOfDay(slice.start);
  const end = startOfDay(slice.end);
  while (cur <= end) {
    keys.push(formatDateInput(cur));
    cur = addDays(cur, 1);
  }
  return keys;
}

async function loadSnapshotProfitsByDay(
  storeOids: mongoose.Types.ObjectId[],
  dateKeys: string[],
  todayKey: string,
): Promise<Map<string, number>> {
  const histKeys = dateKeys.filter((k) => k < todayKey);
  if (!histKeys.length || !storeOids.length) return new Map();

  const rows = await DailyMetric.find({
    storeId: storeOids.length === 1 ? storeOids[0] : { $in: storeOids },
    dateKey: { $in: histKeys },
  })
    .select("dateKey netProfit storeId")
    .lean();

  const out = new Map<string, number>();
  if (storeOids.length === 1) {
    for (const r of rows) {
      out.set(r.dateKey, r.netProfit ?? 0);
    }
    return out;
  }
  for (const r of rows) {
    out.set(r.dateKey, (out.get(r.dateKey) ?? 0) + (r.netProfit ?? 0));
  }
  return out;
}

function sliceFromDateKeys(
  dateKeys: string[],
  storeTimeZone: string,
): PeriodSlice {
  const sorted = [...dateKeys].sort();
  const start = zonedStartOfDay(sorted[0], storeTimeZone);
  const end = zonedEndOfDay(sorted[sorted.length - 1], storeTimeZone);
  if (sorted.length <= 31) {
    return { start, end, specificDates: sorted };
  }
  return { start, end };
}

async function buildDailyProfitSeries(
  wsId: mongoose.Types.ObjectId,
  storeOids: mongoose.Types.ObjectId[],
  slice: PeriodSlice,
  fmtMoney: (v: number) => string,
  storeTimeZone?: string | null,
  cogsMode?: CogsMode | null,
  expenseRows: ExpenseLeanRow[] = [],
  expenseStoreId?: string | null,
): Promise<ProfitChartPoint[]> {
  const dateKeys = dayKeysInSlice(slice, storeTimeZone);

  const [orderByDay, adByDay, chargebacksByDay] = await Promise.all([
    aggregateDailyOrders(
      wsId,
      storeOids,
      slice,
      storeTimeZone,
      cogsMode,
    ),
    aggregateDailyAdSpend(storeOids, slice, storeTimeZone),
    storeTimeZone
      ? sumChargebacksByDayKey(storeOids, slice, storeTimeZone)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const zeroAgg = {
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
  };

  return dateKeys.map((dateKey) => {
    const o = orderByDay.get(dateKey) ?? zeroAgg;
    const { amount: ad, hasEntry } = resolveDailyAdSpend(adByDay, dateKey);
    const dayOpEx = sumLoadedExpensesForDay(
      expenseRows,
      dateKey,
      expenseStoreId ?? undefined,
    );
    const dayCb = chargebacksByDay.get(dateKey) ?? 0;
    const profit = calcDailyProfit(o, hasEntry ? ad : 0, dayOpEx, dayCb);
    const revenue = o.revenue;
    const label = formatDateKeyLabel(dateKey);
    const dateLabel = formatDateKeyLabel(dateKey, { withYear: true });
    return {
      dateKey,
      label,
      dateLabel,
      profit,
      profitFmt: fmtMoney(profit),
      revenue,
      revenueFmt: fmtMoney(revenue),
    };
  });
}

function pctFmtFromCounts(num: number, den: number): string {
  if (den <= 0) return "—";
  return formatPercent((num / den) * 100);
}

function annotateProfitChartConsolidation(
  chart: ProfitChartPoint[],
  refundWindowDays: number,
): ProfitChartPoint[] {
  return chart.map((p) => ({
    ...p,
    consolidated: isDateKeyConsolidated(p.dateKey, refundWindowDays),
  }));
}

function annotateProfitChartNotes(
  chart: ProfitChartPoint[],
  notes: StoreDailyNoteView[],
): ProfitChartPoint[] {
  const byDate = new Map(notes.map((n) => [n.date, n]));
  return chart.map((p) => {
    const note = byDate.get(p.dateKey);
    if (!note) return p;
    const preview =
      note.text.trim() ||
      (note.didScale ? "Scale registado" : "") ||
      (note.mood === "good"
        ? "Dia positivo"
        : note.mood === "bad"
          ? "Dia negativo"
          : "Nota");
    return {
      ...p,
      hasNote: true,
      notePreview: preview.slice(0, 120),
      didScale: note.didScale,
    };
  });
}

async function buildStoreDailyMetrics(
  wsId: mongoose.Types.ObjectId,
  storeOid: mongoose.Types.ObjectId,
  slice: PeriodSlice,
  fmtMoney: (v: number) => string,
  analyticsSessionCountries: string | string[] | null | undefined,
  storeTimeZone?: string | null,
  cogsMode?: CogsMode | null,
  expenseRows: ExpenseLeanRow[] = [],
  cogsDayOpts?: {
    cogsDayFromKey?: string | null;
    cogsModePriorToDayForce?: CogsMode | null;
  },
): Promise<StoreDailyMetricRow[]> {
  const [orderByDay, adByDay, sessionsByDay, missingCogsByDay] =
    await Promise.all([
      aggregateDailyOrders(
        wsId,
        [storeOid],
        slice,
        storeTimeZone,
        cogsMode,
        cogsDayOpts,
      ),
      aggregateDailyAdSpend([storeOid], slice, storeTimeZone),
      loadDailySessionCountsForSlice(
        storeOid,
        analyticsSessionCountries,
        slice,
        storeTimeZone,
      ),
      cogsMode === "order" || cogsMode === "day"
        ? Promise.resolve(new Map<string, number>())
        : countMissingCogsByDay([storeOid], slice, storeTimeZone),
    ]);

  return dayKeysInSlice(slice, storeTimeZone)
    .map((dateKey) => {
    const o = orderByDay.get(dateKey) ?? {
      revenue: 0,
      cogs: 0,
      shipping: 0,
      fees: 0,
      refunds: 0,
      orders: 0,
    };
    const { amount: ad, hasEntry } = resolveDailyAdSpend(adByDay, dateKey);
    const dayOpEx = sumLoadedExpensesForDay(
      expenseRows,
      dateKey,
      String(storeOid),
    );
    const profit = calcDailyProfit(o, hasEntry ? ad : 0, dayOpEx);
    const fromKey = cogsDayOpts?.cogsDayFromKey ?? null;
    const dayNeedsManual =
      cogsMode === "day" && (!fromKey || dateKey >= fromKey);
    const missingCogs =
      dayNeedsManual && o.orders > 0 && o.cogs === 0
        ? 1
        : missingCogsByDay.get(dateKey) ?? 0;
    const dateLabel = formatDateKeyLabel(dateKey, { withYear: true });
    const sess = sessionsByDay.get(dateKey);
    const sessions = sess?.sessions ?? null;
    let profitTitle = formatProfitBreakdown(o, ad, fmtMoney, {
      adSpendKnown: hasEntry,
      operatingExpenses: dayOpEx,
    });
    if (missingCogs > 0) {
      profitTitle += ` · ${missingCogsNote(missingCogs, cogsMode ?? undefined)}`;
    }
    return {
      dateKey,
      dateLabel,
      revenue: fmtMoney(o.revenue),
      cogs: fmtMoney(o.cogs),
      refunds: fmtMoney(o.refunds),
      adSpend: formatAdSpendCell(hasEntry, ad, fmtMoney),
      profit: fmtMoney(profit),
      profitPositive: profit >= 0,
      profitTitle,
      ordersCount: o.orders,
        sessions,
        atcPct: sess ? pctFmtFromCounts(sess.cart, sess.sessions) : "—",
        checkoutPct: sess ? pctFmtFromCounts(sess.checkout, sess.sessions) : "—",
        cvrPct: sess ? pctFmtFromCounts(sess.completed, sess.sessions) : "—",
      };
    })
    .reverse();
}

/** Gráfico de lucro: exclui hoje enquanto o dia não fechou (evita queda artificial). */
function trimIncompleteTodayFromProfitChart(
  chart: ProfitChartPoint[],
  storeTimeZone: string | null | undefined,
  period: Pick<
    ResolvedPeriod,
    "start" | "end" | "specificDates" | "startDateKey" | "endDateKey"
  >,
): ProfitChartPoint[] {
  if (periodIsSingleDay(period) || chart.length <= 1) return chart;
  const tz = normalizeStoreTimezone(storeTimeZone);
  const todayKey = dateKeyInTimezone(new Date(), tz);
  const trimmed = chart.filter((p) => p.dateKey !== todayKey);
  return trimmed.length > 0 ? trimmed : chart;
}

/** Dias completos para sparkline — exclui hoje (dia em curso distorce a tendência). */
function completeDayKeysForSparkline(
  slice: PeriodSlice,
  storeTimeZone: string | null | undefined,
  points: number,
): string[] {
  const tz = normalizeStoreTimezone(storeTimeZone);
  const todayKey = dateKeyInTimezone(new Date(), tz);

  const inPeriod = dayKeysInSlice(slice, storeTimeZone).filter(
    (k) => k < todayKey,
  );
  if (inPeriod.length >= points) {
    return inPeriod.slice(-points);
  }

  const tail: string[] = [];
  const today = parseDateInput(todayKey);
  if (!today) return inPeriod;
  let d = addDays(today, -1);
  while (tail.length < points) {
    tail.unshift(formatDateInput(d));
    d = addDays(d, -1);
  }
  return tail;
}

async function buildStoreSparklinesBatch(
  wsId: mongoose.Types.ObjectId,
  stores: StoreCogsCtx[],
  slice: PeriodSlice,
  storeTimeZone?: string | null,
  points = 7,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!stores.length) return out;

  const tailKeys = completeDayKeysForSparkline(slice, storeTimeZone, points);
  if (tailKeys.length < 2) {
    for (const s of stores) out.set(String(s._id), []);
    return out;
  }

  const tz = normalizeStoreTimezone(storeTimeZone);
  const clippedSlice: PeriodSlice = sliceFromDateKeys(tailKeys, tz);

  const storeOids = stores.map((s) => s._id);
  const [ordersByStoreDay, adByStoreDay] = await Promise.all([
    aggregateDailyOrdersByStore(wsId, stores, clippedSlice, storeTimeZone),
    aggregateDailyAdSpendByStore(storeOids, clippedSlice, storeTimeZone),
  ]);

  const zeroRow = () => ({
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
  });

  for (const s of stores) {
    const sid = String(s._id);
    const profits = tailKeys.map((dateKey) => {
      const o = ordersByStoreDay.get(storeDayKey(dateKey, sid)) ?? zeroRow();
      const { amount: ad, hasEntry } = resolveDailyAdSpend(adByStoreDay, dateKey);
      return calcDailyProfit(o, hasEntry ? ad : 0, 0);
    });
    out.set(sid, profits);
  }
  return out;
}

async function buildStoreSparkline(
  wsId: mongoose.Types.ObjectId,
  storeOid: mongoose.Types.ObjectId,
  slice: PeriodSlice,
  storeTimeZone?: string | null,
  points = 7,
): Promise<number[]> {
  const series = await buildDailyProfitSeries(
    wsId,
    [storeOid],
    slice,
    () => "",
    storeTimeZone,
  );
  const tail = series.slice(-points);
  return tail.map((p) => p.profit ?? 0);
}

async function sumMissingAdSpendDays(
  stores: Array<{
    _id: mongoose.Types.ObjectId;
    name: string;
    importStartDate?: Date | null;
    createdAt?: Date;
  }>,
  currency: string,
): Promise<number> {
  const summaries = await buildStoreAdSpendSummaries(stores, currency);
  return summaries.reduce((s, x) => s + x.missingCount, 0);
}

type OrderForProductRanking = {
  lineItems?: Array<{
    title?: string | null;
    quantity?: number | null;
    unitPrice?: number | null;
    unitCost?: number | null;
  }>;
  netRevenue?: number | null;
  subtotal?: number | null;
  totalPrice?: number | null;
  refunded?: number | null;
  shipping?: number | null;
  fees?: number | null;
  amountsBase?: {
    netRevenue?: number | null;
    cogs?: number | null;
    shipping?: number | null;
    fees?: number | null;
    fxRate?: number | null;
  } | null;
};

function lineStoreRevenue(li: {
  unitPrice?: number | null;
  quantity?: number | null;
}): number {
  return (li.unitPrice ?? 0) * (li.quantity ?? 0);
}

function orderLineRevenueBasis(order: OrderForProductRanking): number {
  let total = 0;
  for (const li of order.lineItems ?? []) {
    total += lineStoreRevenue(li);
  }
  return total;
}

function orderFxRate(order: OrderForProductRanking): number {
  const base = order.amountsBase?.netRevenue;
  const store = order.netRevenue ?? orderNetRevenue(order);
  if (base != null && store > 0) return base / store;
  const fx = order.amountsBase?.fxRate;
  return fx != null && fx > 0 ? fx : 1;
}

/** Reparte um total em moeda base pelas linhas (proporção do preço na loja). */
function allocateBaseFromOrder(
  order: OrderForProductRanking,
  lineStoreAmount: number,
  orderBaseTotal: number | null | undefined,
  storeBasis: number,
): number {
  if (orderBaseTotal != null) {
    if (storeBasis > 0) return orderBaseTotal * (lineStoreAmount / storeBasis);
    const n = order.lineItems?.length ?? 1;
    return orderBaseTotal / Math.max(n, 1);
  }
  return lineStoreAmount * orderFxRate(order);
}

async function buildTopProductsByUnits(
  storeOid: mongoose.Types.ObjectId,
  slice: PeriodSlice,
  fmtMoney: (v: number) => string,
  limit = 5,
  storeTimeZone?: string | null,
): Promise<TopProduct[]> {
  const orders = await Order.find(
    mergePaidOrderFilter({
      storeId: storeOid,
      ...(storeTimeZone
        ? orderDateMatchInTimezone(slice, storeTimeZone)
        : orderDateMatch(slice)),
    }),
  )
    .select(
      "lineItems netRevenue subtotal totalPrice refunded amountsBase.netRevenue amountsBase.fxRate",
    )
    .lean();

  const map = new Map<string, { units: number; revenue: number }>();

  for (const order of orders) {
    const storeBasis =
      orderLineRevenueBasis(order) ||
      order.netRevenue ||
      orderNetRevenue(order);
    const netRevBase = order.amountsBase?.netRevenue;

    for (const li of order.lineItems ?? []) {
      const title = li.title || "(sem nome)";
      const lineRevStore = lineStoreRevenue(li);
      const rev = allocateBaseFromOrder(
        order,
        lineRevStore,
        netRevBase,
        storeBasis,
      );
      const row = map.get(title) ?? { units: 0, revenue: 0 };
      row.units += li.quantity ?? 0;
      row.revenue += rev;
      map.set(title, row);
    }
  }

  return [...map.entries()]
    .sort((a, b) => b[1].units - a[1].units)
    .slice(0, limit)
    .map(([title, p]) => ({
      title,
      units: p.units,
      revenue: fmtMoney(p.revenue),
      profit: "—",
      margin: "—",
      berRoas: "—",
      positive: true,
      marginPositive: true,
    }));
}

async function buildTopProductsByProfit(
  storeOid: mongoose.Types.ObjectId,
  slice: PeriodSlice,
  fmtMoney: (v: number) => string,
  limit = 5,
  storeTimeZone?: string | null,
): Promise<TopProduct[]> {
  const orders = await Order.find(
    mergePaidOrderFilter({
      storeId: storeOid,
      ...(storeTimeZone
        ? orderDateMatchInTimezone(slice, storeTimeZone)
        : orderDateMatch(slice)),
    }),
  )
    .select(
      "lineItems shipping fees refunded totalPrice subtotal netRevenue amountsBase manualCogs cogs",
    )
    .lean();

  const map = new Map<string, { units: number; revenue: number; profit: number }>();

  for (const order of orders) {
    const lines = order.lineItems ?? [];
    const storeBasis =
      orderLineRevenueBasis(order) ||
      order.netRevenue ||
      orderNetRevenue(order);
    const netRevBase =
      order.amountsBase?.netRevenue ??
      (order.netRevenue ?? 0) * orderFxRate(order);
    const feesBase =
      order.amountsBase?.fees ?? (order.fees ?? 0) * orderFxRate(order);
    // Portes cobrados ao cliente são margem, não overhead do produto.
    const overheadBase = feesBase;

    let orderCogsStore = 0;
    for (const li of lines) {
      orderCogsStore += (li.unitCost ?? 0) * (li.quantity ?? 0);
    }
    const cogsBaseTotal = orderCogsBase(order);

    for (const li of lines) {
      const lineRevStore = lineStoreRevenue(li);
      const rev = allocateBaseFromOrder(
        order,
        lineRevStore,
        netRevBase,
        storeBasis,
      );
      const costStore = (li.unitCost ?? 0) * (li.quantity ?? 0);
      const cost =
        cogsBaseTotal != null && orderCogsStore > 0
          ? cogsBaseTotal * (costStore / orderCogsStore)
          : costStore * orderFxRate(order);
      const share = storeBasis > 0 ? lineRevStore / storeBasis : 0;
      const profit = rev - cost - overheadBase * share;
      const title = li.title || "(sem nome)";
      const row = map.get(title) ?? { units: 0, revenue: 0, profit: 0 };
      row.units += li.quantity ?? 0;
      row.revenue += rev;
      row.profit += profit;
      map.set(title, row);
    }
  }

  return [...map.entries()]
    .sort((a, b) => b[1].profit - a[1].profit)
    .slice(0, limit)
    .map(([title, p]) => {
      const marginPct = p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0;
      const berValue = p.profit > 0 ? p.revenue / p.profit : null;
      return {
        title,
        units: p.units,
        revenue: fmtMoney(p.revenue),
        profit: fmtMoney(p.profit),
        margin: formatPercent(marginPct),
        berRoas: fmtBerRoas(berValue),
        positive: p.profit >= 0,
        marginPositive: marginPct >= 0,
      };
    });
}

export type PnlLine = {
  name: string;
  revenue: number;
  cogs: number;
  shipping: number;
  fees: number;
  refunds: number;
  adSpend: number;
  operatingExpenses: number;
  netProfit: number;
  margin: number;
  orders: number;
};

export type WorkspacePnl = {
  currency: string;
  days: number;
  periodLabel: string;
  totals: Omit<PnlLine, "name">;
  stores: PnlLine[];
  cogsIncomplete: boolean;
  missingCogsCount: number;
  /** Texto do aviso de COGS (respeita modo por loja). */
  missingCogsMessage: string;
  missingAdSpendDays: number;
};

/**
 * Fuso para a vista consolidada: o mais comum entre as lojas acessíveis
 * (determinístico, independente do fuso do servidor). Fallback: default.
 */
function dominantStoreTimezone(
  stores: Array<{ ianaTimezone?: string | null }>,
): string {
  const counts = new Map<string, number>();
  for (const s of stores) {
    const tz = normalizeStoreTimezone(s.ianaTimezone);
    counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  let best = DEFAULT_STORE_TIMEZONE;
  let bestCount = -1;
  for (const [tz, n] of counts) {
    if (n > bestCount) {
      best = tz;
      bestCount = n;
    }
  }
  return best;
}

/**
 * P&L (lucro real) por workspace a partir das orders sincronizadas.
 * Lucro = revenue líquida − COGS − envio − taxas − ad spend.
 */
export async function buildWorkspacePnl(
  workspaceId: string,
  periodInput?: PeriodInput,
  storeId?: string,
  storeAccess: StoreAccess = "all",
): Promise<WorkspacePnl> {
  await connectToDatabase();

  const empty: WorkspacePnl = {
    currency: "EUR",
    days: 0,
    periodLabel: "",
    totals: {
      revenue: 0,
      cogs: 0,
      shipping: 0,
      fees: 0,
      refunds: 0,
      adSpend: 0,
      operatingExpenses: 0,
      netProfit: 0,
      margin: 0,
      orders: 0,
    },
    stores: [],
    cogsIncomplete: false,
    missingCogsCount: 0,
    missingCogsMessage: "",
    missingAdSpendDays: 0,
  };

  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const workspace = await Workspace.findById(wsId).lean();
  const currency = workspace?.baseCurrency ?? "EUR";

  const stores = await Store.find({
    workspaceId: wsId,
    deletedAt: null,
    ...NON_ARCHIVED_STORE_FILTER,
  })
    .select("name importStartDate createdAt ianaTimezone cogsMode workspaceId")
    .lean();
  if (stores.length === 0) return { ...empty, currency };

  const accessibleStores =
    storeAccess === "all"
      ? stores
      : stores.filter((s) => canAccessStore(storeAccess, String(s._id)));
  if (accessibleStores.length === 0) return { ...empty, currency };

  const scoped =
    storeId && canAccessStore(storeAccess, storeId)
      ? accessibleStores.find((s) => String(s._id) === storeId)
      : null;
  if (storeId && !scoped) return { ...empty, currency };
  const storeTz = scoped
    ? normalizeStoreTimezone(scoped.ianaTimezone)
    : dominantStoreTimezone(accessibleStores);
  const period = resolvePeriodForStore(periodInput, storeTz);
  const days = periodDayCount(period);
  const pnlSlice: PeriodSlice = {
    start: period.start,
    end: period.end,
    specificDates: period.specificDates,
  };

  empty.days = days;
  empty.periodLabel = period.label;
  const storeList = scoped ? [scoped] : accessibleStores;

  const byStore = await aggregateStoreAggs(wsId, storeList, pnlSlice, storeTz);

  const adSpendByStore = new Map<string, number>();
  const cbByStore = await sumChargebacksByStore(
    storeList.map((s) => s._id),
    pnlSlice,
    storeTz,
  );
  await Promise.all(
    storeList.map(async (s) => {
      const tz = normalizeStoreTimezone(s.ianaTimezone);
      const v = await sumAdSpendForPeriod([s._id], pnlSlice, tz);
      adSpendByStore.set(String(s._id), v);
    }),
  );

  const expensesByStore = scoped
    ? null
    : await sumOperatingExpensesByStore(
        wsId,
        pnlSlice,
        storeList.map((s) => s._id),
      );
  const scopedOperatingExpenses = scoped
    ? await sumOperatingExpensesForPeriod(wsId, pnlSlice, String(scoped._id))
    : 0;

  const toLine = (
    name: string,
    a: StoreAgg,
    storeOid: mongoose.Types.ObjectId,
    operatingExpenses: number,
  ): PnlLine => {
    const storeAd = adSpendByStore.get(String(storeOid)) ?? 0;
    const storeCb = cbByStore.get(String(storeOid)) ?? 0;
    const netProfit = calcProfit(a, storeAd, operatingExpenses, storeCb);
    return {
      name,
      revenue: a.revenue,
      cogs: a.cogs,
      shipping: a.shipping,
      fees: a.fees,
      refunds: a.refunds,
      adSpend: storeAd,
      operatingExpenses,
      netProfit,
      margin: a.revenue > 0 ? (netProfit / a.revenue) * 100 : 0,
      orders: a.orders,
    };
  };

  const storeLines = storeList
    .map((s) =>
      toLine(
        s.name,
        byStore.get(String(s._id)) ?? {
          revenue: 0,
          cogs: 0,
          shipping: 0,
          fees: 0,
          refunds: 0,
          orders: 0,
        },
        s._id,
        scoped
          ? scopedOperatingExpenses
          : (expensesByStore?.get(String(s._id)) ?? 0),
      ),
    )
    .sort((a, b) => b.revenue - a.revenue);

  const t = storeLines.reduce(
    (acc, l) => {
      acc.revenue += l.revenue;
      acc.cogs += l.cogs;
      acc.shipping += l.shipping;
      acc.fees += l.fees;
      acc.refunds += l.refunds;
      acc.orders += l.orders;
      return acc;
    },
    { revenue: 0, cogs: 0, shipping: 0, fees: 0, refunds: 0, orders: 0 },
  );
  const totalAdSpend = [...adSpendByStore.values()].reduce((s, v) => s + v, 0);
  const totalChargebacks = [...cbByStore.values()].reduce((s, v) => s + v, 0);
  const totalOperatingExpenses = scoped
    ? scopedOperatingExpenses
    : await sumOperatingExpensesForPeriod(wsId, pnlSlice);
  const netProfit = calcProfit(
    t,
    totalAdSpend,
    totalOperatingExpenses,
    totalChargebacks,
  );
  const [missingCogsCount, missingAdSpendDays] = await Promise.all([
    countMissingCogsForStores(storeList, pnlSlice),
    sumMissingAdSpendDays(storeList, currency),
  ]);
  const missingCogsMessage = scoped
    ? formatMissingCogsWarning(
        missingCogsCount,
        (scoped.cogsMode ?? "shopify") as CogsMode,
      )
    : formatMissingCogsWarning(missingCogsCount);

  return {
    currency,
    days,
    periodLabel: period.label,
    totals: {
      ...t,
      adSpend: totalAdSpend,
      operatingExpenses: totalOperatingExpenses,
      netProfit,
      margin: t.revenue > 0 ? (netProfit / t.revenue) * 100 : 0,
    },
    stores: storeLines,
    cogsIncomplete: missingCogsCount > 0,
    missingCogsCount,
    missingCogsMessage,
    missingAdSpendDays,
  };
}

/** Resumo vazio quando o workspace ainda não tem lojas ligadas. */
function emptyCostBreakdown(currency = "EUR"): CostBreakdown {
  const zero = formatCurrency(0, currency);
  return {
    totalCosts: 0,
    totalCostsFmt: zero,
    revenue: 0,
    revenueFmt: zero,
    netProfit: 0,
    netProfitFmt: zero,
    items: [],
    adSpendKnown: false,
  };
}

/** Repartição de custos do período (painel lateral + KPI «Custos totais»). */
export function buildCostBreakdown(
  agg: StoreAgg,
  adSpend: number,
  adSpendKnown: boolean,
  operatingExpenses: number,
  netProfit: number,
  fmtMoney: (v: number) => string,
  chargebacks = 0,
): CostBreakdown {
  const items: CostBreakdownItem[] = [
    { key: "cogs", label: "Custo de produto", value: agg.cogs },
    { key: "fees", label: "Taxas", value: agg.fees },
    ...(adSpendKnown
      ? [{ key: "adspend", label: "Anúncios", value: adSpend }]
      : []),
    ...(operatingExpenses > 0
      ? [{ key: "opex", label: "Despesas operacionais", value: operatingExpenses }]
      : []),
    ...(chargebacks > 0
      ? [{ key: "chargebacks", label: "Chargebacks", value: chargebacks }]
      : []),
  ]
    .filter((i) => i.value > 0)
    .map((i) => ({ ...i, valueFmt: fmtMoney(i.value) }));

  if (agg.shipping > 0) {
    items.push({
      key: "shipping",
      label: "Portes cobrados",
      value: agg.shipping,
      valueFmt: fmtMoney(agg.shipping),
      informative: true,
    });
  }

  if (agg.refunds > 0) {
    items.push({
      key: "refunds",
      label: "Reembolsos",
      value: agg.refunds,
      valueFmt: fmtMoney(agg.refunds),
      informative: true,
    });
  }

  const totalCosts = items
    .filter((i) => !i.informative)
    .reduce((s, i) => s + i.value, 0);

  return {
    totalCosts,
    totalCostsFmt: fmtMoney(totalCosts),
    revenue: agg.revenue,
    revenueFmt: fmtMoney(agg.revenue),
    netProfit,
    netProfitFmt: fmtMoney(netProfit),
    items,
    adSpendKnown,
  };
}

function emptySummary(currency = "EUR"): DashboardSummary {
  const zero = formatCurrency(0, currency);
  const zeroCompact = formatCurrencyCompact(0, currency);
  return {
    kpis: [
      { label: "Faturamento", value: zeroCompact, title: zero },
      { label: "Net Profit", value: zeroCompact, title: zero },
      { label: "Custos totais", value: zeroCompact, title: zero },
      { label: "Margem %", value: "0,0%" },
      { label: "Ad Spend", value: zeroCompact, title: zero },
      { label: "ROAS", value: "—" },
      { label: "BER", value: "—" },
    ],
    stores: [],
    scopeName: null,
    scopeDomain: null,
    topProducts: [],
    topProductsMode: "profit",
    storeDashboard: null,
    generatedAt: new Date().toISOString(),
    dailyNotes: [],
    cogsIncomplete: false,
    missingCogsCount: 0,
    missingCogsMessage: "",
    missingAdSpendDays: 0,
    profitChart: [],
    dailyMetrics: [],
    extendedKpis: [],
    costBreakdown: emptyCostBreakdown(currency),
    refundWindowDays: 30,
    profitWindowStatus: "provisional",
    profitWindowNote: profitWindowNote("provisional", 30),
    monthlyGoals: null,
    lastSyncedAt: null,
  };
}

/**
 * Calcula o resumo do dashboard para um workspace, a partir das orders
 * sincronizadas. Lucro = revenue líquida − COGS − envio − taxas − ad spend manual.
 */
export async function buildWorkspaceSummary(
  workspaceId: string,
  storeId?: string,
  periodInput?: PeriodInput,
  storeAccess: StoreAccess = "all",
): Promise<DashboardSummary> {
  await connectToDatabase();

  if (!workspaceId) return emptySummary();

  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const workspace = await Workspace.findById(wsId).lean();
  const currency = workspace?.baseCurrency ?? "EUR";

  const allStores = await Store.find({
    workspaceId: wsId,
    deletedAt: null,
    ...NON_ARCHIVED_STORE_FILTER,
  })
    .select(
      "name shopDomain displayUrl paymentsBalance importStartDate createdAt analyticsSessionCountry analyticsSessionCountries ianaTimezone lastSessionMetricsError cogsMode cogsDayFromKey cogsModePriorToDayForce workspaceId operationStatus operationKilledAt status collectionTestCycleDays collectionReminderDaysBefore",
    )
    .lean();

  if (allStores.length === 0) return emptySummary(currency);

  const accessibleStores =
    storeAccess === "all"
      ? allStores
      : allStores.filter((s) => canAccessStore(storeAccess, String(s._id)));
  if (accessibleStores.length === 0) return emptySummary(currency);

  const storeColorMap = buildStoreColorMap(
    accessibleStores.map((s) => ({ id: String(s._id), name: s.name })),
  );

  // Vista de uma só loja (se válida e pertencente ao workspace).
  const scoped =
    storeId && canAccessStore(storeAccess, storeId)
      ? accessibleStores.find((s) => String(s._id) === storeId)
      : null;
  if (storeId && !scoped) return emptySummary(currency);

  if (storeId && !scoped) return emptySummary(currency);

  const scopeName = scoped ? scoped.name : null;
  const scopeDomain = scoped ? getStoreDisplayUrl(scoped) : null;
  const storeTz = scoped
    ? normalizeStoreTimezone(scoped.ianaTimezone)
    : dominantStoreTimezone(accessibleStores);
  const scopedCogsMode = (scoped?.cogsMode ?? "shopify") as CogsMode;
  const topProductsMode: "profit" | "units" = ranksProductsByUnits(scopedCogsMode)
    ? "units"
    : "profit";

  const period = resolvePeriodForStore(periodInput, storeTz);
  const {
    start,
    end,
    label: periodLabel,
    prevStart,
    prevEnd,
    prevLabel: prevPeriodLabel,
    prevSpecificDates,
  } = period;

  const currentSlice: PeriodSlice = {
    start,
    end,
    specificDates: period.specificDates,
  };
  const prevSlice: PeriodSlice = prevSpecificDates
    ? { start: prevStart, end: prevEnd, specificDates: prevSpecificDates }
    : { start: prevStart, end: prevEnd };

  const financialSplit = scoped
    ? null
    : filterStoresForFinancialMetrics(accessibleStores, currentSlice);

  const stores = scoped
    ? [scoped]
    : (financialSplit?.included ?? storesForFinancialConsolidated(accessibleStores));

  let effectiveCurrentSlice = currentSlice;
  let effectivePrevSlice = prevSlice;

  if (scoped && resolveStoreOperationStatus(scoped) === "killed") {
    const curClip = clipSliceForKilledStore(scoped, currentSlice);
    if (!curClip) {
      return {
        ...emptySummary(currency),
        operationContext: {
          exclusionNote:
            "Este período é posterior à data em que a loja foi matada — sem métricas financeiras.",
          excludedWaiting: 0,
          excludedKilled: 1,
          scopedStoreStatus: "killed",
          collectionReminders: [],
        },
      };
    }
    effectiveCurrentSlice = curClip;
    effectivePrevSlice =
      clipSliceForKilledStore(scoped, prevSlice) ?? prevSlice;
  }

  const hasKilledPartial =
    !scoped &&
    accessibleStores.some(
      (s) =>
        resolveStoreOperationStatus(s) === "killed" &&
        clipSliceForKilledStore(s, currentSlice) !== null,
    );

  const importFloor = scoped
    ? resolveImportFloor(scoped.importStartDate, scoped.createdAt)
    : earliestImportFloor(stores);
  /** Consolidado multi-loja: eixo = período completo; cada loja só desenha após a sua importação. */
  const chartSlice: PeriodSlice =
    !scoped && stores.length > 1
      ? effectiveCurrentSlice
      : clampSliceToImportFloor(effectiveCurrentSlice, importFloor);
  let effectiveChartSlice = chartSlice;
  if (scoped && resolveStoreOperationStatus(scoped) === "killed") {
    effectiveChartSlice =
      clipSliceForKilledStore(scoped, chartSlice) ?? chartSlice;
  }

  const refundWindowDays = workspace?.refundWindowDays ?? 30;
  const profitWindowStatus = classifyProfitWindow(
    dayKeysInSlice(chartSlice, storeTz),
    refundWindowDays,
  );
  const profitWindowNoteText = profitWindowNote(
    profitWindowStatus,
    refundWindowDays,
  );

  async function aggregateOrders(
    slice: PeriodSlice,
    storeOid?: mongoose.Types.ObjectId,
  ): Promise<StoreAgg> {
    const match = mergePaidOrderFilter({
      workspaceId: wsId,
      ...orderDateMatchInTimezone(slice, storeTz),
      ...(storeOid ? { storeId: storeOid } : {}),
    });

    const mode = storeOid ? scopedCogsMode : null;
    const fromKey = storeOid
      ? ((scoped as { cogsDayFromKey?: string | null } | null)?.cogsDayFromKey ??
        null)
      : null;
    const priorMode = isCogsMode(
      (scoped as { cogsModePriorToDayForce?: string | null } | null)
        ?.cogsModePriorToDayForce ?? "",
    )
      ? ((scoped as { cogsModePriorToDayForce?: string }).cogsModePriorToDayForce as CogsMode)
      : "shopify";
    const hybridDay = mode === "day" && Boolean(fromKey);
    const cogsExpr = cogsSumExprForMode(hybridDay ? priorMode : mode);

    const [row] = await Order.aggregate<StoreAgg>([
      { $match: match },
      {
        $group: {
          _id: null,
          revenue: netRevenueSumBaseExpr,
          cogs: cogsExpr,
          shipping: shippingSumBaseExpr,
          fees: feesSumBaseExpr,
          refunds: { $sum: 0 },
          orders: { $sum: 1 },
        },
      },
    ]);
    const agg = row ?? {
      revenue: 0,
      cogs: 0,
      shipping: 0,
      fees: 0,
      refunds: 0,
      orders: 0,
    };

    const issued = await sumRefundsIssuedInPeriod(
      wsId,
      storeOid ? [storeOid] : stores.map((s) => s._id),
      slice,
      storeTz,
    );
    agg.refunds = issued;

    if (mode === "day" && storeOid) {
      if (hybridDay && fromKey) {
        const keys = dayKeysInSlice(slice, storeTz);
        const beforeKeys = keys.filter((k) => k < fromKey);
        const afterKeys = keys.filter((k) => k >= fromKey);
        let cogs = 0;
        if (beforeKeys.length) {
          const beforeSlice: PeriodSlice = {
            start: slice.start,
            end: slice.end,
            specificDates: beforeKeys,
          };
          const [beforeRow] = await Order.aggregate<{ cogs: number }>([
            {
              $match: mergePaidOrderFilter({
                workspaceId: wsId,
                storeId: storeOid,
                ...orderDateMatchInTimezone(beforeSlice, storeTz),
              }),
            },
            { $group: { _id: null, cogs: cogsSumExprForMode(priorMode) } },
          ]);
          cogs += beforeRow?.cogs ?? 0;
          if (appliesEuCategoryFees(priorMode)) {
            const euByDay = await sumEuCategoryFeesByDay(storeOid, beforeKeys);
            for (const fee of euByDay.values()) cogs += fee;
          }
        }
        if (afterKeys.length) {
          cogs += await sumManualCogsForPeriod(
            [storeOid],
            { start: slice.start, end: slice.end, specificDates: afterKeys },
            storeTz,
          );
        }
        agg.cogs = cogs;
      } else {
        agg.cogs = await sumManualCogsForPeriod([storeOid], slice, storeTz);
      }
    }

    if (storeOid && mode && appliesEuCategoryFees(mode) && !hybridDay) {
      agg.cogs += await sumEuCategoryFeesForPeriod([storeOid], slice, storeTz);
    }

    return agg;
  }

  const byStore = await aggregateStoreAggsWithKillClip(
    wsId,
    stores,
    effectiveCurrentSlice,
    aggregateStoreAggs,
    storeTz,
  );

  const fmtMoney = (v: number) => formatCurrency(v, currency);
  const fmtMargin = (rev: number, profit: number) =>
    rev > 0 ? formatPercent((profit / rev) * 100) : "—";

  const storeOids = stores.map((s) => s._id);
  const expenseRows = await loadWorkspaceExpensesLean(wsId);
  const scopedStoreId = scoped ? String(scoped._id) : null;
  const curOperatingExpenses = sumLoadedExpenses(
    expenseRows,
    effectiveCurrentSlice,
    scopedStoreId,
  );
  const prevOperatingExpenses = sumLoadedExpenses(
    expenseRows,
    effectivePrevSlice,
    scopedStoreId,
  );
  const opExByStore =
    !scoped && expenseRows.length > 0
      ? sumLoadedExpensesByStore(
          expenseRows,
          currentSlice,
          stores.map((s) => String(s._id)),
        )
      : new Map<string, number>();

  const [curAdAgg, prevAdAgg, curCbByStore, prevCbByStore] = await Promise.all([
    aggregateAdSpendWithKillClip(stores, effectiveCurrentSlice),
    aggregateAdSpendWithKillClip(stores, effectivePrevSlice),
    sumChargebacksByStore(storeOids, effectiveCurrentSlice, storeTz),
    sumChargebacksByStore(storeOids, effectivePrevSlice, storeTz),
  ]);
  const adSpend = curAdAgg.total;
  const prevAdSpend = prevAdAgg.total;
  const adSpendEntryByStore = curAdAgg.entriesByStore;
  const prevAdSpendEntryByStore = prevAdAgg.entriesByStore;
  const adSpendByStore = curAdAgg.byStore;
  const curChargebacks = [...curCbByStore.values()].reduce((s, v) => s + v, 0);
  const prevChargebacks = [...prevCbByStore.values()].reduce((s, v) => s + v, 0);
  const curAdSpendKnownWorkspace = [...adSpendEntryByStore.values()].some(
    (n) => n > 0,
  );
  const prevAdSpendKnownWorkspace = [...prevAdSpendEntryByStore.values()].some(
    (n) => n > 0,
  );
  const scopedAdSpendKnown = scoped
    ? (adSpendEntryByStore.get(String(scoped._id)) ?? 0) > 0
    : false;
  const scopedPrevAdSpendKnown = scoped
    ? (prevAdSpendEntryByStore.get(String(scoped._id)) ?? 0) > 0
    : false;

  const [missingCogsCount, missingAdSpendDays] = await Promise.all([
    scoped
      ? scopedCogsMode === "order"
        ? countOrdersMissingManualCogs(
            [scoped._id],
            effectiveCurrentSlice,
            storeTz,
          )
        : scopedCogsMode === "day"
          ? countMissingCogsDays(scoped, effectiveCurrentSlice)
          : countSoldVariantsMissingCost(
              [scoped._id],
              effectiveCurrentSlice,
            )
      : countMissingCogsForStores(stores, effectiveCurrentSlice),
    sumMissingAdSpendDays(stores, currency),
  ]);
  const cogsIncomplete = missingCogsCount > 0;
  const missingCogsMessage = scoped
    ? formatMissingCogsWarning(missingCogsCount, scopedCogsMode)
    : formatMissingCogsWarning(missingCogsCount);

  const sparklinesByStore =
    !scoped && stores.length > 0
      ? await buildStoreSparklinesBatch(
          wsId,
          stores,
          effectiveCurrentSlice,
          storeTz,
        )
      : null;

  const summaryStores: SummaryStore[] = stores
    .map((s) => {
      const a = byStore.get(String(s._id)) ?? {
        revenue: 0,
        cogs: 0,
        shipping: 0,
        fees: 0,
        refunds: 0,
        orders: 0,
      };
      const storeAd = adSpendByStore.get(String(s._id)) ?? 0;
      const storeAdKnown =
        (adSpendEntryByStore.get(String(s._id)) ?? 0) > 0;
      const storeOpEx = scoped
        ? curOperatingExpenses
        : (opExByStore.get(String(s._id)) ?? 0);
      const storeCb = curCbByStore.get(String(s._id)) ?? 0;
      const profit = calcProfit(
        a,
        storeAdKnown ? storeAd : 0,
        storeOpEx,
        storeCb,
      );
      const marginPct = a.revenue > 0 ? (profit / a.revenue) * 100 : 0;
      const roasNum =
        storeAdKnown && storeAd > 0 ? a.revenue / storeAd : null;
      const roas =
        roasNum != null ? roasNum.toFixed(2).replace(".", ",") : "—";
      const trend = sparklinesByStore?.get(String(s._id)) ?? [];
      return {
        storeId: String(s._id),
        name: s.name,
        color: storeColorMap.get(String(s._id)) ?? "#5B5EA6",
        revenue: fmtMoney(a.revenue),
        profit: fmtMoney(profit),
        margin: fmtMargin(a.revenue, profit),
        adSpend: storeAdKnown ? fmtMoney(storeAd) : "—",
        roas,
        positive: profit >= 0,
        trend,
        sort: {
          revenue: a.revenue,
          profit,
          margin: marginPct,
          adSpend: storeAd,
          roas: roasNum,
        },
      };
    })
    .sort((x, y) => y.sort.revenue - x.sort.revenue);

  const sortedStores: SummaryStore[] = summaryStores;

  const totals = [...byStore.values()].reduce(
    (acc, a) => {
      acc.revenue += a.revenue;
      acc.cogs += a.cogs;
      acc.shipping += a.shipping;
      acc.fees += a.fees;
      acc.refunds += a.refunds;
      acc.orders += a.orders;
      return acc;
    },
    { revenue: 0, cogs: 0, shipping: 0, fees: 0, refunds: 0, orders: 0 },
  );

  const netProfit = calcProfit(
    totals,
    curAdSpendKnownWorkspace ? adSpend : 0,
    curOperatingExpenses,
    curChargebacks,
  );
  const margin = totals.revenue > 0 ? (netProfit / totals.revenue) * 100 : 0;
  const curBer = storeBerRoas(totals);

  const money = (v: number): SummaryKpi["value"] =>
    formatCurrency(v, currency);
  const deltaSuffix = `var. % vs ${prevPeriodLabel}`;

  const profitChartTask = (async (): Promise<{
    points: ProfitChartPoint[];
    series?: ProfitChartSeries[];
  }> => {
    if (!scoped && stores.length > 1) {
      const consolidated = await buildConsolidatedDailyProfitSeries(
        wsId,
        stores,
        storeColorMap,
        chartSlice,
        fmtMoney,
        storeTz,
        expenseRows,
      );
      return { points: consolidated.points, series: consolidated.series };
    }
    const points = await buildDailyProfitSeries(
      wsId,
      storeOids,
      scoped ? effectiveChartSlice : chartSlice,
      fmtMoney,
      storeTz,
      scoped ? scopedCogsMode : null,
      expenseRows,
      scopedStoreId,
    );
    return { points };
  })();

  let kpis: SummaryKpi[];
  let extendedKpis: SummaryKpi[] = [];
  let scopedCurAgg: StoreAgg | null = null;
  let scopedPrevAgg: StoreAgg | null = null;
  const scopedCurCb = scoped
    ? (curCbByStore.get(String(scoped._id)) ?? 0)
    : 0;
  const scopedPrevCb = scoped
    ? (prevCbByStore.get(String(scoped._id)) ?? 0)
    : 0;

  if (scoped) {
    const [cur, prev] = await Promise.all([
      aggregateOrders(effectiveCurrentSlice, scoped._id),
      aggregateOrders(effectivePrevSlice, scoped._id),
    ]);
    scopedCurAgg = cur;
    scopedPrevAgg = prev;
    const curAdSpend = adSpend;
    const curAdSpendForProfit = scopedAdSpendKnown ? curAdSpend : 0;
    const prevAdSpendForProfit = scopedPrevAdSpendKnown ? prevAdSpend : 0;
    const curProfit = calcProfit(
      cur,
      curAdSpendForProfit,
      curOperatingExpenses,
      scopedCurCb,
    );
    const prevProfit = calcProfit(
      prev,
      prevAdSpendForProfit,
      prevOperatingExpenses,
      scopedPrevCb,
    );
    const curMargin =
      cur.revenue > 0 ? (curProfit / cur.revenue) * 100 : 0;
    const prevMargin =
      prev.revenue > 0 ? (prevProfit / prev.revenue) * 100 : 0;
    const curBer = storeBerRoas(cur);
    const prevBer = storeBerRoas(prev);
    const curCm = contributionMarginPct(marginInputsFromAgg(cur));
    const curRoas =
      scopedAdSpendKnown && curAdSpend > 0 ? cur.revenue / curAdSpend : null;
    const prevRoas =
      scopedPrevAdSpendKnown && prevAdSpend > 0
        ? prev.revenue / prevAdSpend
        : null;
    const totalCostsStore =
      cur.cogs +
      cur.fees +
      (scopedAdSpendKnown ? curAdSpend : 0) +
      curOperatingExpenses +
      scopedCurCb;
    const prevTotalCostsStore =
      prev.cogs +
      prev.fees +
      (scopedPrevAdSpendKnown ? prevAdSpend : 0) +
      prevOperatingExpenses +
      scopedPrevCb;

    kpis = [
      {
        label: "Faturamento",
        value: money(cur.revenue),
        title: fmtMoney(cur.revenue),
        delta: deltaPct(cur.revenue, prev.revenue),
        deltaLabel: deltaSuffix,
        icon: "euro",
      },
      {
        label: "Net Profit",
        value: money(curProfit),
        title: cogsIncomplete
          ? `${formatProfitBreakdown(cur, curAdSpend, fmtMoney, { adSpendKnown: scopedAdSpendKnown, operatingExpenses: curOperatingExpenses, chargebacks: scopedCurCb })} · ${missingCogsNote(missingCogsCount, scopedCogsMode)}`
          : formatProfitBreakdown(cur, curAdSpend, fmtMoney, {
              adSpendKnown: scopedAdSpendKnown,
              operatingExpenses: curOperatingExpenses,
              chargebacks: scopedCurCb,
            }),
        delta: deltaPct(curProfit, prevProfit),
        deltaLabel: deltaSuffix,
        icon: "euro",
      },
      {
        label: "Custos totais",
        value: money(totalCostsStore),
        title: `Produto + taxas${scopedAdSpendKnown ? " + anúncios" : ""}${curOperatingExpenses > 0 ? " + despesas" : ""}${scopedCurCb > 0 ? " + chargebacks" : ""} = ${fmtMoney(totalCostsStore)}`,
        delta: deltaPct(totalCostsStore, prevTotalCostsStore),
        deltaLabel: deltaSuffix,
        icon: "euro",
      },
      {
        label: "Margem %",
        value: formatPercent(curMargin),
        delta: curMargin - prevMargin,
        deltaLabel: deltaSuffix,
        deltaIsPoints: true,
        icon: "percent",
      },
      {
        label: "Ad Spend",
        value: scopedAdSpendKnown ? money(curAdSpend) : "—",
        title: scopedAdSpendKnown
          ? fmtMoney(curAdSpend)
          : "Por preencher em Anúncios — não entra no lucro até registares",
        delta:
          scopedAdSpendKnown && scopedPrevAdSpendKnown
            ? deltaPct(curAdSpend, prevAdSpend)
            : undefined,
        deltaLabel: scopedAdSpendKnown ? deltaSuffix : undefined,
        icon: "euro",
      },
      {
        label: "ROAS",
        value: curRoas != null ? curRoas.toFixed(2).replace(".", ",") : "—",
        delta:
          curRoas != null && prevRoas != null
            ? deltaPct(curRoas, prevRoas)
            : undefined,
        deltaLabel: curRoas != null ? deltaSuffix : undefined,
        icon: "target",
      },
    ];
  } else {
    const totalCostsWorkspace =
      totals.cogs +
      totals.fees +
      (curAdSpendKnownWorkspace ? adSpend : 0) +
      curOperatingExpenses +
      curChargebacks;
    kpis = [
      {
        label: "Faturamento",
        value: money(totals.revenue),
        title: fmtMoney(totals.revenue),
      },
      {
        label: "Net Profit",
        value: money(netProfit),
        title: cogsIncomplete
          ? `${formatProfitBreakdown(totals, adSpend, fmtMoney, { adSpendKnown: curAdSpendKnownWorkspace, operatingExpenses: curOperatingExpenses, chargebacks: curChargebacks })} · ${missingCogsNote(missingCogsCount, null)}`
          : formatProfitBreakdown(totals, adSpend, fmtMoney, {
              adSpendKnown: curAdSpendKnownWorkspace,
              operatingExpenses: curOperatingExpenses,
              chargebacks: curChargebacks,
            }),
      },
      {
        label: "Custos totais",
        value: money(totalCostsWorkspace),
        title: `Produto + taxas${curAdSpendKnownWorkspace ? " + anúncios" : ""}${curOperatingExpenses > 0 ? " + despesas" : ""}${curChargebacks > 0 ? " + chargebacks" : ""} = ${fmtMoney(totalCostsWorkspace)}`,
      },
      { label: "Margem %", value: formatPercent(margin) },
      {
        label: "Ad Spend",
        value: curAdSpendKnownWorkspace ? money(adSpend) : "—",
        title: curAdSpendKnownWorkspace
          ? fmtMoney(adSpend)
          : "Por preencher em Anúncios — não entra no lucro até registares",
      },
      {
        label: "ROAS",
        value:
          curAdSpendKnownWorkspace && adSpend > 0
            ? (totals.revenue / adSpend).toFixed(2).replace(".", ",")
            : "—",
      },
    ];
    const curAll = totals;
    const prevByStore = await aggregateStoreAggsWithKillClip(
      wsId,
      stores,
      effectivePrevSlice,
      aggregateStoreAggs,
      storeTz,
    );
    const prevAll = [...prevByStore.values()].reduce(
      (acc, a) => {
        acc.revenue += a.revenue;
        acc.cogs += a.cogs;
        acc.shipping += a.shipping;
        acc.fees += a.fees;
        acc.refunds += a.refunds;
        acc.orders += a.orders;
        return acc;
      },
      {
        revenue: 0,
        cogs: 0,
        shipping: 0,
        fees: 0,
        refunds: 0,
        orders: 0,
      },
    );
    const prevBerWorkspace = storeBerRoas(prevAll);
    extendedKpis = [
      {
        label: "BER",
        value: fmtRoasRatio(curBer),
        title:
          curBer != null
            ? "Break-even ROAS — mínimo vs ROAS (ads + agência). Inclui COGS/taxa supplier e taxas de pagamento"
            : "Sem margem de contribuição positiva",
        delta:
          curBer != null && prevBerWorkspace != null
            ? deltaPct(curBer, prevBerWorkspace)
            : undefined,
        deltaLabel: curBer != null ? deltaSuffix : undefined,
        deltaInverted: true,
        icon: "trending",
      },
      ...buildExtendedWorkspaceKpis(
        curAll,
        prevAll,
        adSpend,
        prevAdSpend,
        curAdSpendKnownWorkspace,
        prevAdSpendKnownWorkspace,
        curOperatingExpenses,
        prevOperatingExpenses,
        deltaSuffix,
        money,
        fmtMoney,
        curChargebacks,
        prevChargebacks,
      ),
    ];
  }

  if (profitWindowStatus !== "consolidated") {
    kpis = kpis.map((k) =>
      k.label === "Net Profit"
        ? {
            ...k,
            title: k.title
              ? `${k.title} · ${profitWindowNoteText}`
              : profitWindowNoteText,
          }
        : k,
    );
  }

  let profitChart: ProfitChartPoint[];
  let profitChartSeries: ProfitChartSeries[] | undefined;

  const chartBuilt = await profitChartTask;
  profitChart = trimIncompleteTodayFromProfitChart(
    chartBuilt.points,
    storeTz,
    period,
  );
  profitChartSeries = chartBuilt.series;

  // Vista por loja: produtos por lucro + waterfall + payout + métricas diárias.
  let topProducts: TopProduct[] = [];
  let storeDashboard: StoreDashboardData | null = null;
  let dailyNotes: StoreDailyNoteView[] = [];
  let dailyMetrics: StoreDailyMetricRow[] = [];

  if (scoped && scopedCurAgg) {
    const cur = scopedCurAgg;
    const curAdSpend = adSpend;

    const storeImportFloorKey = importDateKey(
      scoped.importStartDate,
      scoped.createdAt,
      storeTz,
    );
    const sessionCountries = sessionCountryKeysFromStore(scoped);
    const sessionCountryInput =
      sessionCountries.length > 0 ? sessionCountries : null;

    const [
      topProductsResult,
      storePayouts,
      dailyNotesResult,
      funnelCur,
      funnelPrev,
      dailyRows,
      euCustomsFee,
    ] = await Promise.all([
      topProductsMode === "units"
        ? buildTopProductsByUnits(
            scoped._id,
            effectiveCurrentSlice,
            fmtMoney,
            5,
            storeTz,
          )
        : buildTopProductsByProfit(
            scoped._id,
            effectiveCurrentSlice,
            fmtMoney,
            5,
            storeTz,
          ),
      Payout.find({
        workspaceId: wsId,
        storeId: scoped._id,
      }).lean(),
      fetchStoreDailyNotesForPeriod(
        wsId,
        scoped._id,
        effectiveCurrentSlice,
      ),
      aggregateSessionFunnelFromDb(
        scoped._id,
        sessionCountryInput,
        effectiveCurrentSlice,
        storeImportFloorKey,
        storeTz,
      ),
      aggregateSessionFunnelFromDb(
        scoped._id,
        sessionCountryInput,
        effectivePrevSlice,
        storeImportFloorKey,
        storeTz,
      ),
      buildStoreDailyMetrics(
        wsId,
        scoped._id,
        effectiveCurrentSlice,
        fmtMoney,
        sessionCountryInput,
        storeTz,
        scopedCogsMode,
        expenseRows,
        {
          cogsDayFromKey: scoped.cogsDayFromKey ?? null,
          cogsModePriorToDayForce: isCogsMode(
            scoped.cogsModePriorToDayForce ?? "",
          )
            ? (scoped.cogsModePriorToDayForce as CogsMode)
            : null,
        },
      ),
      appliesAutoEuCustomsFees(scopedCogsMode)
        ? sumEuCategoryFeesForPeriod(
            [scoped._id],
            effectiveCurrentSlice,
            storeTz,
          )
        : Promise.resolve(0),
    ]);

    topProducts = topProductsResult;
    dailyNotes = dailyNotesResult;

    const grossRevenue = cur.revenue + cur.refunds;
    const adSpendForWaterfall = scopedAdSpendKnown ? curAdSpend : 0;
    const netProfit = calcProfit(
      cur,
      adSpendForWaterfall,
      curOperatingExpenses,
      scopedCurCb,
    );
    /** Waterfall: taxa UE Win-Win em «EU TAX»; repartição de custos mantém-a no COGS. */
    const waterfallCogs = cur.cogs - euCustomsFee;

    const waterfallCostSteps: WaterfallStep[] = [
      {
        key: "cogs",
        label: "COGS",
        value: -waterfallCogs,
        display: fmtMoney(-waterfallCogs),
        type: "negative",
      },
    ];

    if (euCustomsFee > 0) {
      waterfallCostSteps.push({
        key: "eu_tax",
        label: "EU TAX",
        value: -euCustomsFee,
        display: fmtMoney(-euCustomsFee),
        type: "negative",
      });
    }

    const waterfall: WaterfallStep[] = [
      {
        key: "revenue",
        label: "Revenue",
        value: grossRevenue,
        display: fmtMoney(grossRevenue),
        type: "start",
      },
      ...waterfallCostSteps,
      {
        key: "fees",
        label: "Taxas",
        value: -cur.fees,
        display: fmtMoney(-cur.fees),
        type: "negative",
      },
      ...(scopedAdSpendKnown && curAdSpend > 0
        ? [
            {
              key: "adspend",
              label: "Ad Spend",
              value: -curAdSpend,
              display: fmtMoney(-curAdSpend),
              type: "negative" as const,
            },
          ]
        : []),
      ...(curOperatingExpenses > 0
        ? [
            {
              key: "opex",
              label: "Despesas",
              value: -curOperatingExpenses,
              display: fmtMoney(-curOperatingExpenses),
              type: "negative" as const,
            },
          ]
        : []),
      ...(scopedCurCb > 0
        ? [
            {
              key: "chargebacks",
              label: "Chargebacks",
              value: -scopedCurCb,
              display: fmtMoney(-scopedCurCb),
              type: "negative" as const,
            },
          ]
        : []),
      ...(cur.refunds > 0
        ? [
            {
              key: "refunds",
              label: "Refunds",
              value: -cur.refunds,
              display: fmtMoney(-cur.refunds),
              type: "negative" as const,
            },
          ]
        : []),
      {
        key: "net",
        label: "Net Profit",
        value: netProfit,
        display: fmtMoney(netProfit),
        type: "total",
      },
    ];

    const payoutAmount = scoped.paymentsBalance ?? 0;

    const incomingStatuses = new Set([
      "scheduled",
      "in_transit",
      "pending",
      "action_required",
    ]);
    const nextPayout = storePayouts
      .filter(
        (p) =>
          incomingStatuses.has(normPayoutStatus(p.status)) && p.issuedAt,
      )
      .sort(
        (a, b) =>
          new Date(a.issuedAt!).getTime() - new Date(b.issuedAt!).getTime(),
      )[0];

    const nextDate = nextPayout?.issuedAt
      ? new Date(nextPayout.issuedAt)
      : null;

    profitChart = annotateProfitChartNotes(profitChart, dailyNotes);
    profitChart = annotateProfitChartConsolidation(profitChart, refundWindowDays);

    const noteByDate = new Map(dailyNotes.map((n) => [n.date, n]));
    dailyMetrics = dailyRows.map((row) => {
      const note = noteByDate.get(row.dateKey);
      return {
        ...row,
        hasNote: Boolean(note),
        notePreview: note?.text?.trim() || undefined,
      };
    });

    const sessionErr = scoped.lastSessionMetricsError ?? null;
    let funnelError = funnelCur.error;
    if (sessionErr && funnelCur.sessions === 0) {
      funnelError = `Falha ao obter sessões: ${sessionErr}`;
    } else if (sessionErr && funnelCur.error) {
      funnelError = `${funnelCur.error} (${sessionErr})`;
    }

    const prevForExtended = scopedPrevAgg ?? {
      revenue: 0,
      cogs: 0,
      shipping: 0,
      fees: 0,
      refunds: 0,
      orders: 0,
    };
    const [adInsightsCur, adInsightsPrev] = await Promise.all([
      aggregateStoreAdInsightsForPeriod(
        String(scoped._id),
        dayKeysInSlice(effectiveCurrentSlice, storeTz),
      ),
      aggregateStoreAdInsightsForPeriod(
        String(scoped._id),
        dayKeysInSlice(effectivePrevSlice, storeTz),
      ),
    ]);
    const curBerExtended = storeBerRoas(cur);
    const prevBerExtended = storeBerRoas(prevForExtended);
    const curContributionMarginExtended = contributionMarginPct(
      marginInputsFromAgg(cur),
    );
    extendedKpis = [
      {
        label: "BER",
        value: fmtRoasRatio(curBerExtended),
        title:
          curBerExtended != null
            ? `Break-even ROAS — COGS (taxa supplier) + taxas de pagamento; comparar com ROAS que inclui fee de agência (margem contrib. ${formatPercent(curContributionMarginExtended)})`
            : "Sem margem de contribuição positiva",
        delta:
          curBerExtended != null && prevBerExtended != null
            ? deltaPct(curBerExtended, prevBerExtended)
            : undefined,
        deltaLabel: curBerExtended != null ? deltaSuffix : undefined,
        deltaInverted: true,
        icon: "trending",
      },
      ...buildExtendedStoreKpis(
        cur,
        prevForExtended,
        curAdSpend,
        prevAdSpend,
        scopedAdSpendKnown,
        scopedPrevAdSpendKnown,
        curOperatingExpenses,
        prevOperatingExpenses,
        funnelCur,
        funnelPrev,
        adInsightsCur,
        adInsightsPrev,
        deltaSuffix,
        money,
        fmtMoney,
        scopedCurCb,
        scopedPrevCb,
      ),
    ];

    storeDashboard = {
      waterfall,
      payout: {
        amount: payoutAmount,
        amountFmt: fmtMoney(payoutAmount),
        nextDate: nextDate?.toISOString() ?? null,
        nextDateLabel: nextDate
          ? nextDate.toLocaleDateString("pt-PT", {
              day: "numeric",
              month: "short",
            })
          : null,
      },
      periodLabel,
      prevPeriodLabel,
      periodIsSingleDay: periodIsSingleDay(period),
      dailyNotes,
      funnelKpis: buildFunnelKpis(funnelCur, funnelPrev, deltaSuffix),
      funnelError,
      sessionCountryLabel: funnelCur.countryLabel,
      lastSessionMetricsError: sessionErr,
    };
  } else {
    const wsNotes = await fetchWorkspaceDailyNotesForPeriod(wsId, currentSlice);
    profitChart = annotateProfitChartNotes(profitChart, wsNotes);
    profitChart = annotateProfitChartConsolidation(profitChart, refundWindowDays);
  }

  const reminderStoreIds = stores.map((s) => s._id);
  const collectionReminders = await listCollectionRemindersForWorkspace(
    workspaceId,
    reminderStoreIds,
  );
  const operationContext = {
    exclusionNote: financialSplit
      ? operationExclusionNote(
          financialSplit.excludedKilled,
          hasKilledPartial,
        )
      : scoped && resolveStoreOperationStatus(scoped) === "killed"
        ? "Métricas desta loja só incluem dias até à data em que foi matada."
        : null,
    excludedWaiting: 0,
    excludedKilled: financialSplit?.excludedKilled ?? 0,
    scopedStoreStatus: scoped
      ? resolveStoreOperationStatus(scoped)
      : null,
    collectionReminders,
  };

  const costBreakdownAdKnown = scoped
    ? scopedAdSpendKnown
    : curAdSpendKnownWorkspace;
  const costBreakdown = buildCostBreakdown(
    scopedCurAgg ?? totals,
    costBreakdownAdKnown ? adSpend : 0,
    costBreakdownAdKnown,
    curOperatingExpenses,
    netProfit,
    fmtMoney,
    scoped ? (curCbByStore.get(String(scoped._id)) ?? 0) : curChargebacks,
  );

  const syncStoreIds = storeId
    ? [storeId]
    : accessibleStores.map((s) => String(s._id));
  const lastSyncedAt = await resolveLastSyncedAtForStoreIds(syncStoreIds);

  return {
    kpis,
    stores: sortedStores,
    scopeName,
    scopeDomain,
    topProducts,
    topProductsMode,
    storeDashboard,
    dailyNotes,
    cogsIncomplete,
    missingCogsCount,
    missingCogsMessage,
    missingAdSpendDays,
    profitChart,
    profitChartSeries,
    dailyMetrics,
    extendedKpis,
    costBreakdown,
    refundWindowDays,
    profitWindowStatus,
    profitWindowNote: profitWindowNoteText,
    generatedAt: new Date().toISOString(),
    lastSyncedAt,
    monthlyGoals: await buildMonthlyGoalsProgress(
      workspaceId,
      storeId,
      storeAccess,
    ),
    operationContext,
  };
}

/** Ranking de produtos por lucro (página Produtos da loja). */
export async function buildStoreProductRanking(
  workspaceId: string,
  storeId: string,
  periodInput?: PeriodInput,
  limit = 20,
): Promise<{
  products: TopProduct[];
  storeName: string;
  periodLabel: string;
  mode: "profit" | "units";
}> {
  await connectToDatabase();
  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const store = await Store.findOne({
    _id: storeId,
    workspaceId: wsId,
    deletedAt: null,
    ...NON_ARCHIVED_STORE_FILTER,
  })
    .select("name currency ianaTimezone cogsMode")
    .lean();
  if (!store) {
    return { products: [], storeName: "", periodLabel: "", mode: "profit" as const };
  }

  const cogsMode = (store.cogsMode ?? "shopify") as CogsMode;
  const byUnits = ranksProductsByUnits(cogsMode);

  const storeTz = normalizeStoreTimezone(store.ianaTimezone);
  const period = resolvePeriodForStore(periodInput, storeTz);
  const currency =
    (await Workspace.findById(wsId).lean())?.baseCurrency ??
    store.currency ??
    "EUR";
  const fmtMoney = (v: number) => formatCurrency(v, currency);
  const slice: PeriodSlice = {
    start: period.start,
    end: period.end,
    specificDates: period.specificDates,
  };

  const products = byUnits
    ? await buildTopProductsByUnits(
        store._id,
        slice,
        fmtMoney,
        limit,
        storeTz,
      )
    : await buildTopProductsByProfit(
        store._id,
        slice,
        fmtMoney,
        limit,
        storeTz,
      );

  return {
    products,
    storeName: store.name,
    periodLabel: period.label,
    mode: byUnits ? "units" : "profit",
  };
}

export type StoreDayFunnelByCountry = {
  code: string;
  label: string;
  sessions: number | null;
  atcPct: number | null;
  checkoutPct: number | null;
  cvrPct: number | null;
};

export type StoreDayFinancials = {
  revenue: number;
  cogs: number;
  refunds: number;
  shipping: number;
  fees: number;
  /** null = dia sem registo manual em Anúncios. */
  adSpend: number | null;
  operatingExpenses: number;
  chargebacks: number;
  profit: number;
  missingCogs: number;
  sessions: number | null;
  atcPct: number | null;
  checkoutPct: number | null;
  cvrPct: number | null;
  /** Presente com 2+ países de sessões — report separado. */
  funnelByCountry?: StoreDayFunnelByCountry[];
};

function pctFromCounts(part: number, total: number): number | null {
  if (total <= 0) return null;
  return (part / total) * 100;
}

/** Métricas financeiras e funil de um único dia (relatório diário). */
export async function fetchStoreDayFinancials(
  workspaceId: string,
  storeId: string,
  dateKey: string,
): Promise<StoreDayFinancials | null> {
  await connectToDatabase();
  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const store = await Store.findOne({
    _id: storeId,
    workspaceId: wsId,
    deletedAt: null,
    ...NON_ARCHIVED_STORE_FILTER,
  })
    .select(
      "ianaTimezone analyticsSessionCountry analyticsSessionCountries cogsMode cogsDayFromKey cogsModePriorToDayForce",
    )
    .lean();
  if (!store) return null;

  const cogsMode = (store.cogsMode ?? "shopify") as CogsMode;

  const day = parseDateInput(dateKey);
  if (!day) return null;

  const storeTz = normalizeStoreTimezone(store.ianaTimezone);
  const slice: PeriodSlice = {
    start: day,
    end: day,
    specificDates: [dateKey],
  };

  const storeOid = store._id;
  const expenseRows = await loadWorkspaceExpensesLean(wsId);
  const operatingExpenses = sumLoadedExpensesForDay(
    expenseRows,
    dateKey,
    storeId,
  );

  const sessionCountries = sessionCountryKeysFromStore(store);
  const sessionCountryInput =
    sessionCountries.length > 0 ? sessionCountries : null;

  const cogsDayOpts = {
    cogsDayFromKey: store.cogsDayFromKey ?? null,
    cogsModePriorToDayForce: isCogsMode(store.cogsModePriorToDayForce ?? "")
      ? (store.cogsModePriorToDayForce as CogsMode)
      : null,
  };

  const [orderByDay, adByDay, sessionsByDay, missingCogsByDay, byCountryMaps, dayChargebacks] =
    await Promise.all([
      aggregateDailyOrders(
        wsId,
        [storeOid],
        slice,
        storeTz,
        cogsMode,
        cogsDayOpts,
      ),
      aggregateDailyAdSpend([storeOid], slice, storeTz),
      loadDailySessionCountsForSlice(
        storeOid,
        sessionCountryInput,
        slice,
        storeTz,
      ),
      cogsMode === "order" || cogsMode === "day"
        ? Promise.resolve(new Map<string, number>())
        : countMissingCogsByDay([storeOid], slice, storeTz),
      sessionCountries.length > 1
        ? loadDailySessionCountsByCountryForSlice(
            storeOid,
            sessionCountries,
            slice,
            storeTz,
          )
        : Promise.resolve(new Map()),
      sumChargebacksForStoreDay(storeOid, slice, storeTz),
    ]);

  const o = orderByDay.get(dateKey) ?? {
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
    orders: 0,
  };
  const { amount: ad, hasEntry } = resolveDailyAdSpend(adByDay, dateKey);
  const profit = calcDailyProfit(o, hasEntry ? ad : 0, operatingExpenses, dayChargebacks);
  const fromKey = store.cogsDayFromKey ?? null;
  const dayNeedsManual =
    cogsMode === "day" && (!fromKey || dateKey >= fromKey);
  const missingCogs =
    dayNeedsManual && o.orders > 0 && o.cogs === 0
      ? 1
      : cogsMode === "order"
        ? await countOrdersMissingManualCogs([storeOid], slice, storeTz)
        : missingCogsByDay.get(dateKey) ?? 0;
  const sess = sessionsByDay.get(dateKey);

  const funnelByCountry: StoreDayFunnelByCountry[] | undefined =
    sessionCountries.length > 1
      ? sessionCountries.map((code) => {
          const daySess = byCountryMaps.get(code)?.get(dateKey);
          return {
            code,
            label: sessionCountryLabel(code),
            sessions: daySess?.sessions ?? null,
            atcPct: daySess
              ? pctFromCounts(daySess.cart, daySess.sessions)
              : null,
            checkoutPct: daySess
              ? pctFromCounts(daySess.checkout, daySess.sessions)
              : null,
            cvrPct: daySess
              ? pctFromCounts(daySess.completed, daySess.sessions)
              : null,
          };
        })
      : undefined;

  return {
    revenue: o.revenue,
    cogs: o.cogs,
    refunds: o.refunds,
    shipping: o.shipping,
    fees: o.fees,
    adSpend: hasEntry ? ad : null,
    operatingExpenses,
    chargebacks: dayChargebacks,
    profit,
    missingCogs,
    sessions: sess?.sessions ?? null,
    atcPct: sess ? pctFromCounts(sess.cart, sess.sessions) : null,
    checkoutPct: sess ? pctFromCounts(sess.checkout, sess.sessions) : null,
    cvrPct: sess ? pctFromCounts(sess.completed, sess.sessions) : null,
    funnelByCountry,
  };
}

export type StoreRangeFinancials = StoreDayFinancials & {
  startKey: string;
  endKey: string;
  dayCount: number;
};

/** Métricas financeiras e funil agregadas num intervalo de dias (relatório semanal). */
export async function fetchStoreRangeFinancials(
  workspaceId: string,
  storeId: string,
  dateKeys: string[],
): Promise<StoreRangeFinancials | null> {
  if (!dateKeys.length) return null;
  await connectToDatabase();
  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const store = await Store.findOne({
    _id: storeId,
    workspaceId: wsId,
    deletedAt: null,
    ...NON_ARCHIVED_STORE_FILTER,
  })
    .select(
      "ianaTimezone analyticsSessionCountry analyticsSessionCountries cogsMode cogsDayFromKey cogsModePriorToDayForce",
    )
    .lean();
  if (!store) return null;

  const cogsMode = (store.cogsMode ?? "shopify") as CogsMode;
  const sortedKeys = [...dateKeys].sort();
  const startKey = sortedKeys[0]!;
  const endKey = sortedKeys[sortedKeys.length - 1]!;
  const start = parseDateInput(startKey);
  const end = parseDateInput(endKey);
  if (!start || !end) return null;

  const storeTz = normalizeStoreTimezone(store.ianaTimezone);
  const slice: PeriodSlice = {
    start,
    end,
    specificDates: sortedKeys,
  };

  const storeOid = store._id;
  const expenseRows = await loadWorkspaceExpensesLean(wsId);
  const operatingExpenses = sortedKeys.reduce(
    (sum, key) => sum + sumLoadedExpensesForDay(expenseRows, key, storeId),
    0,
  );

  const sessionCountries = sessionCountryKeysFromStore(store);
  const sessionCountryInput =
    sessionCountries.length > 0 ? sessionCountries : null;

  const cogsDayOpts = {
    cogsDayFromKey: store.cogsDayFromKey ?? null,
    cogsModePriorToDayForce: isCogsMode(store.cogsModePriorToDayForce ?? "")
      ? (store.cogsModePriorToDayForce as CogsMode)
      : null,
  };

  const [orderByDay, adByDay, sessionsByDay, missingCogsByDay, byCountryMaps, rangeChargebacks] =
    await Promise.all([
      aggregateDailyOrders(
        wsId,
        [storeOid],
        slice,
        storeTz,
        cogsMode,
        cogsDayOpts,
      ),
      aggregateDailyAdSpend([storeOid], slice, storeTz),
      loadDailySessionCountsForSlice(
        storeOid,
        sessionCountryInput,
        slice,
        storeTz,
      ),
      cogsMode === "order" || cogsMode === "day"
        ? Promise.resolve(new Map<string, number>())
        : countMissingCogsByDay([storeOid], slice, storeTz),
      sessionCountries.length > 1
        ? loadDailySessionCountsByCountryForSlice(
            storeOid,
            sessionCountries,
            slice,
            storeTz,
          )
        : Promise.resolve(new Map()),
      sumChargebacksForStoreDay(storeOid, slice, storeTz),
    ]);

  const totals: StoreAgg = {
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
    orders: 0,
  };
  let adSpend = 0;
  let adSpendHasEntry = false;
  let missingCogs = 0;
  const sessTotals = { sessions: 0, cart: 0, checkout: 0, completed: 0 };
  let hasSessions = false;

  for (const key of sortedKeys) {
    const o = orderByDay.get(key);
    if (o) {
      totals.revenue += o.revenue;
      totals.cogs += o.cogs;
      totals.shipping += o.shipping;
      totals.fees += o.fees;
      totals.refunds += o.refunds;
      totals.orders += o.orders;
    }
    const { amount, hasEntry } = resolveDailyAdSpend(adByDay, key);
    if (hasEntry) {
      adSpend += amount;
      adSpendHasEntry = true;
    }
    const sess = sessionsByDay.get(key);
    if (sess) {
      sessTotals.sessions += sess.sessions;
      sessTotals.cart += sess.cart;
      sessTotals.checkout += sess.checkout;
      sessTotals.completed += sess.completed;
      hasSessions = true;
    }
    missingCogs += missingCogsByDay.get(key) ?? 0;
  }

  if (cogsMode === "order") {
    missingCogs = await countOrdersMissingManualCogs([storeOid], slice, storeTz);
  } else if (cogsMode === "day") {
    const fromKey = store.cogsDayFromKey ?? null;
    missingCogs = 0;
    for (const key of sortedKeys) {
      if (fromKey && key < fromKey) continue;
      const o = orderByDay.get(key);
      if (o && o.orders > 0 && o.cogs === 0) missingCogs += 1;
    }
  }

  const profit = calcDailyProfit(
    totals,
    adSpendHasEntry ? adSpend : 0,
    operatingExpenses,
    rangeChargebacks,
  );

  const funnelByCountry: StoreDayFunnelByCountry[] | undefined =
    sessionCountries.length > 1
      ? sessionCountries.map((code) => {
          const map = byCountryMaps.get(code);
          let sessions = 0;
          let cart = 0;
          let checkout = 0;
          let completed = 0;
          let found = false;
          if (map) {
            for (const key of sortedKeys) {
              const d = map.get(key);
              if (!d) continue;
              found = true;
              sessions += d.sessions;
              cart += d.cart;
              checkout += d.checkout;
              completed += d.completed;
            }
          }
          return {
            code,
            label: sessionCountryLabel(code),
            sessions: found ? sessions : null,
            atcPct: found ? pctFromCounts(cart, sessions) : null,
            checkoutPct: found ? pctFromCounts(checkout, sessions) : null,
            cvrPct: found ? pctFromCounts(completed, sessions) : null,
          };
        })
      : undefined;

  return {
    revenue: totals.revenue,
    cogs: totals.cogs,
    refunds: totals.refunds,
    shipping: totals.shipping,
    fees: totals.fees,
    adSpend: adSpendHasEntry ? adSpend : null,
    operatingExpenses,
    chargebacks: rangeChargebacks,
    profit,
    missingCogs,
    sessions: hasSessions ? sessTotals.sessions : null,
    atcPct: hasSessions ? pctFromCounts(sessTotals.cart, sessTotals.sessions) : null,
    checkoutPct: hasSessions
      ? pctFromCounts(sessTotals.checkout, sessTotals.sessions)
      : null,
    cvrPct: hasSessions
      ? pctFromCounts(sessTotals.completed, sessTotals.sessions)
      : null,
    funnelByCountry,
    startKey,
    endKey,
    dayCount: sortedKeys.length,
  };
}

export type StoreDailyOrderTotals = {
  revenue: number;
  refunds: number;
  cogs: number;
};

/** Totais diários de encomendas (receita líquida, reembolsos, COGS) para exportações. */
export async function loadStoreDailyOrderTotalsByDay(
  workspaceId: string,
  storeId: string,
  fromKey: string,
  toKey: string,
): Promise<Map<string, StoreDailyOrderTotals> | null> {
  await connectToDatabase();
  const wsId = new mongoose.Types.ObjectId(workspaceId);
  const store = await Store.findOne({
    _id: storeId,
    workspaceId: wsId,
    deletedAt: null,
    ...NON_ARCHIVED_STORE_FILTER,
  })
    .select(
      "ianaTimezone cogsMode cogsDayFromKey cogsModePriorToDayForce",
    )
    .lean();
  if (!store) return null;

  const storeTz = normalizeStoreTimezone(store.ianaTimezone);
  const cogsMode = (store.cogsMode ?? "shopify") as CogsMode;
  const cogsDayOpts = {
    cogsDayFromKey: store.cogsDayFromKey ?? null,
    cogsModePriorToDayForce: isCogsMode(store.cogsModePriorToDayForce ?? "")
      ? (store.cogsModePriorToDayForce as CogsMode)
      : null,
  };

  const { start, end } = {
    start: zonedStartOfDay(fromKey, storeTz),
    end: zonedEndOfDay(toKey, storeTz),
  };
  const slice = { start, end };

  const orderByDay = await aggregateDailyOrders(
    wsId,
    [store._id],
    slice,
    storeTz,
    cogsMode,
    cogsDayOpts,
  );

  const result = new Map<string, StoreDailyOrderTotals>();
  for (const [dateKey, o] of orderByDay) {
    result.set(dateKey, {
      revenue: o.revenue,
      refunds: o.refunds,
      cogs: o.cogs,
    });
  }
  return result;
}
