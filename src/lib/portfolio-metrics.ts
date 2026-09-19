import "server-only";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { Membership } from "@/models/Membership";
import { Workspace } from "@/models/Workspace";
import { listUserWorkspaces } from "@/lib/auth";
import { normalizeStoreAccess, type StoreAccess } from "@/lib/store-access";
import {
  buildCostBreakdown,
  buildWorkspacePnl,
  type DashboardSummary,
  type ProfitChartPoint,
  type SummaryKpi,
} from "@/lib/metrics";
import { getCachedWorkspaceSummary } from "@/lib/metrics-summary-cache";
import { parsePortfolioParam } from "@/lib/portfolio-scope";
import { resolvePeriod, formatDateInput, type PeriodInput } from "@/lib/period";
import { convertToBaseCurrency } from "@/lib/fx";
import { storeBerRoas, calcNetProfit, withoutCustomerShipping } from "@/lib/profit";
import {
  formatCurrency,
  formatPercent,
} from "@/lib/utils";
import { buildStoreColorMap } from "@/lib/store-colors";
import { Store } from "@/models/Store";
import { resolveLastSyncedAtForStoreIds } from "@/lib/last-sync-at";
import { NON_ARCHIVED_STORE_FILTER } from "@/lib/store-scope";

export type SummaryWorkspace = {
  workspaceId: string;
  name: string;
  color: string;
  revenue: string;
  profit: string;
  margin: string;
  adSpend: string;
  roas: string;
  storeCount: number;
  positive: boolean;
  /** 1 = mais rentável no período */
  profitRank?: number;
  sort: {
    revenue: number;
    profit: number;
    margin: number;
    adSpend: number;
    roas: number | null;
  };
};

export type PortfolioSummary = Omit<DashboardSummary, "stores"> & {
  portfolioMode: true;
  portfolioLabel: string;
  displayCurrency: string;
  workspaces: SummaryWorkspace[];
  stores: [];
};

type MoneyAgg = {
  revenue: number;
  cogs: number;
  shipping: number;
  fees: number;
  refunds: number;
  adSpend: number;
  orders: number;
};

async function convertMoney(
  amount: number,
  from: string,
  to: string,
  dateKey: string,
): Promise<number> {
  if (!amount) return 0;
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  const fx = await convertToBaseCurrency(amount, from, to, dateKey);
  return fx.amountBase;
}

async function convertAgg(
  agg: MoneyAgg,
  from: string,
  to: string,
  dateKey: string,
): Promise<MoneyAgg> {
  const [revenue, cogs, shipping, fees, refunds, adSpend] = await Promise.all([
    convertMoney(agg.revenue, from, to, dateKey),
    convertMoney(agg.cogs, from, to, dateKey),
    convertMoney(agg.shipping, from, to, dateKey),
    convertMoney(agg.fees, from, to, dateKey),
    convertMoney(agg.refunds, from, to, dateKey),
    convertMoney(agg.adSpend, from, to, dateKey),
  ]);
  return {
    revenue,
    cogs,
    shipping,
    fees,
    refunds,
    adSpend,
    orders: agg.orders,
  };
}

async function membershipStoreAccess(
  userId: string,
  workspaceId: string,
): Promise<StoreAccess> {
  const membership = await Membership.findOne({
    userId: new mongoose.Types.ObjectId(userId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    status: "active",
  })
    .select("storeAccess")
    .lean();
  return normalizeStoreAccess(membership?.storeAccess ?? "all");
}

export async function resolvePortfolioWorkspaceIds(
  userId: string,
  portfolioParam: string | null | undefined,
): Promise<string[]> {
  const parsed = parsePortfolioParam(portfolioParam);
  if (!parsed) return [];

  const accessible = await listUserWorkspaces(userId);
  const allowed = new Set(accessible.map((w) => w.id));

  if (parsed === "all") {
    return accessible.map((w) => w.id);
  }

  return parsed.filter((id) => allowed.has(id));
}

async function mergePortfolioProfitChart(
  workspaceIds: string[],
  userId: string,
  periodInput: PeriodInput | undefined,
  displayCurrency: string,
  fmtMoney: (v: number) => string,
): Promise<ProfitChartPoint[]> {
  const dateKey = formatDateInput(resolvePeriod(periodInput ?? {}).end);
  const byDate = new Map<string, ProfitChartPoint>();

  await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      const storeAccess = await membershipStoreAccess(userId, workspaceId);
      const ws = await Workspace.findById(workspaceId).select("baseCurrency").lean();
      const from = ws?.baseCurrency ?? "EUR";
      const summary = await getCachedWorkspaceSummary(
        workspaceId,
        undefined,
        periodInput,
        storeAccess,
      );

      for (const point of summary.profitChart) {
        if (point.profit == null && point.revenue == null) continue;
        const profit = await convertMoney(
          point.profit ?? 0,
          from,
          displayCurrency,
          point.dateKey || dateKey,
        );
        const revenue = await convertMoney(
          point.revenue ?? 0,
          from,
          displayCurrency,
          point.dateKey || dateKey,
        );
        const existing = byDate.get(point.dateKey);
        if (existing) {
          existing.profit = (existing.profit ?? 0) + profit;
          existing.profitFmt = fmtMoney(existing.profit);
          existing.revenue = (existing.revenue ?? 0) + revenue;
          existing.revenueFmt = fmtMoney(existing.revenue);
        } else {
          byDate.set(point.dateKey, {
            ...point,
            profit,
            profitFmt: fmtMoney(profit),
            revenue,
            revenueFmt: fmtMoney(revenue),
            byStore: undefined,
          });
        }
      }
    }),
  );

  return [...byDate.values()].sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey),
  );
}

export async function buildPortfolioSummary(
  userId: string,
  activeWorkspaceId: string,
  portfolioParam: string,
  periodInput?: PeriodInput,
): Promise<PortfolioSummary | null> {
  const workspaceIds = await resolvePortfolioWorkspaceIds(userId, portfolioParam);
  if (workspaceIds.length < 2) return null;

  await connectToDatabase();

  const accessible = await listUserWorkspaces(userId);
  const wsMeta = new Map(accessible.map((w) => [w.id, w]));
  const colorMap = buildStoreColorMap(
    workspaceIds.map((id) => ({
      id,
      name: wsMeta.get(id)?.name ?? id,
    })),
  );

  const activeWs = await Workspace.findById(activeWorkspaceId)
    .select("baseCurrency")
    .lean();
  const displayCurrency = activeWs?.baseCurrency ?? "EUR";
  const period = resolvePeriod(periodInput ?? {});
  const fxDateKey = formatDateInput(period.end);
  const fmtMoney = (v: number) => formatCurrency(v, displayCurrency);
  const money = (v: number): SummaryKpi["value"] =>
    formatCurrency(v, displayCurrency);

  const rows: SummaryWorkspace[] = [];
  let totalAgg: MoneyAgg = {
    revenue: 0,
    cogs: 0,
    shipping: 0,
    fees: 0,
    refunds: 0,
    adSpend: 0,
    orders: 0,
  };
  let cogsIncomplete = false;
  let missingCogsCount = 0;
  let missingCogsMessage = "";
  let missingAdSpendDays = 0;

  const workspaceRows = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      const meta = wsMeta.get(workspaceId);
      if (!meta) return null;

      const storeAccess = await membershipStoreAccess(userId, workspaceId);
      const [pnl, storeCount] = await Promise.all([
        buildWorkspacePnl(
          workspaceId,
          periodInput,
          undefined,
          storeAccess,
        ),
        Store.countDocuments({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          deletedAt: null,
          ...NON_ARCHIVED_STORE_FILTER,
        }),
      ]);

      const converted = await convertAgg(
        {
          revenue: pnl.totals.revenue,
          cogs: pnl.totals.cogs,
          shipping: pnl.totals.shipping,
          fees: pnl.totals.fees,
          refunds: pnl.totals.refunds,
          adSpend: pnl.totals.adSpend,
          orders: pnl.totals.orders,
        },
        pnl.currency,
        displayCurrency,
        fxDateKey,
      );

      const profit = calcNetProfit(
        withoutCustomerShipping(converted),
        converted.adSpend,
      );
      const marginPct =
        converted.revenue > 0 ? (profit / converted.revenue) * 100 : 0;
      const roasNum =
        converted.adSpend > 0 ? converted.revenue / converted.adSpend : null;

      return {
        row: {
          workspaceId,
          name: meta.name,
          color: colorMap.get(workspaceId) ?? "#5B5EA6",
          revenue: fmtMoney(converted.revenue),
          profit: fmtMoney(profit),
          margin: formatPercent(marginPct),
          adSpend:
            pnl.missingAdSpendDays > 0 && converted.adSpend === 0
              ? "—"
              : fmtMoney(converted.adSpend),
          roas:
            roasNum != null ? roasNum.toFixed(2).replace(".", ",") : "—",
          storeCount,
          positive: profit >= 0,
          sort: {
            revenue: converted.revenue,
            profit,
            margin: marginPct,
            adSpend: converted.adSpend,
            roas: roasNum,
          },
        } satisfies SummaryWorkspace,
        converted,
        pnl,
      };
    }),
  );

  for (const entry of workspaceRows) {
    if (!entry) continue;
    rows.push(entry.row);

    totalAgg = {
      revenue: totalAgg.revenue + entry.converted.revenue,
      cogs: totalAgg.cogs + entry.converted.cogs,
      shipping: totalAgg.shipping + entry.converted.shipping,
      fees: totalAgg.fees + entry.converted.fees,
      refunds: totalAgg.refunds + entry.converted.refunds,
      adSpend: totalAgg.adSpend + entry.converted.adSpend,
      orders: totalAgg.orders + entry.converted.orders,
    };

    if (entry.pnl.cogsIncomplete) cogsIncomplete = true;
    missingCogsCount += entry.pnl.missingCogsCount;
    if (entry.pnl.missingCogsMessage) {
      missingCogsMessage = missingCogsMessage
        ? `${missingCogsMessage} ${entry.pnl.missingCogsMessage}`
        : entry.pnl.missingCogsMessage;
    }
    missingAdSpendDays += entry.pnl.missingAdSpendDays;
  }

  const sorted = rows.sort((a, b) => b.sort.profit - a.sort.profit);
  sorted.forEach((row, i) => {
    row.profitRank = i + 1;
  });

  const netProfit = calcNetProfit(
    withoutCustomerShipping(totalAgg),
    totalAgg.adSpend,
  );
  const margin =
    totalAgg.revenue > 0 ? (netProfit / totalAgg.revenue) * 100 : 0;
  const roas =
    totalAgg.adSpend > 0 ? totalAgg.revenue / totalAgg.adSpend : null;
  const ber = storeBerRoas(totalAgg);

  const kpis: SummaryKpi[] = [
    {
      label: "Net Profit",
      value: money(netProfit),
      title: cogsIncomplete
        ? "COGS incompleto — lucro pode estar distorcido"
        : undefined,
    },
    {
      label: "Faturamento",
      value: money(totalAgg.revenue),
    },
    {
      label: "Custos totais",
      value: money(
        totalAgg.cogs +
          totalAgg.fees +
          totalAgg.adSpend,
      ),
    },
    {
      label: "Margem",
      value: formatPercent(margin),
    },
    {
      label: "Ad Spend",
      value: money(totalAgg.adSpend),
    },
    {
      label: "ROAS",
      value: roas != null ? roas.toFixed(2).replace(".", ",") : "—",
    },
    {
      label: "BER",
      value: ber != null ? ber.toFixed(2).replace(".", ",") : "—",
      deltaInverted: true,
    },
  ];

  const profitChart = await mergePortfolioProfitChart(
    workspaceIds,
    userId,
    periodInput,
    displayCurrency,
    fmtMoney,
  );

  const label =
    parsePortfolioParam(portfolioParam) === "all"
      ? `Todos os workspaces (${workspaceIds.length})`
      : `${workspaceIds.length} workspaces`;

  const wsOids = workspaceIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const portfolioStores = wsOids.length
    ? await Store.find({
        workspaceId: { $in: wsOids },
        deletedAt: null,
        ...NON_ARCHIVED_STORE_FILTER,
      })
        .select("_id")
        .lean()
    : [];
  const lastSyncedAt = await resolveLastSyncedAtForStoreIds(
    portfolioStores.map((s) => String(s._id)),
  );

  return {
    portfolioMode: true,
    portfolioLabel: label,
    displayCurrency,
    kpis,
    extendedKpis: [],
    workspaces: sorted,
    stores: [],
    scopeName: null,
    scopeDomain: null,
    topProducts: [],
    topProductsMode: "profit",
    storeDashboard: null,
    dailyNotes: [],
    cogsIncomplete,
    missingCogsCount,
    missingCogsMessage,
    missingAdSpendDays,
    profitChart,
    dailyMetrics: [],
    costBreakdown: buildCostBreakdown(
      totalAgg,
      totalAgg.adSpend,
      true,
      0,
      netProfit,
      fmtMoney,
    ),
    refundWindowDays: 30,
    profitWindowStatus: "provisional",
    profitWindowNote: "Lucro provisório — período dentro da janela de 30 dias; reembolsos ainda podem alterar o resultado.",
    generatedAt: new Date().toISOString(),
    lastSyncedAt,
    monthlyGoals: null,
  };
}
