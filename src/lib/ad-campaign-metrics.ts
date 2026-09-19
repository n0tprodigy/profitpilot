import "server-only";
import mongoose from "mongoose";
import { AdCampaignDay } from "@/models/AdCampaignDay";
import type { AdPlatform } from "@/lib/ad-spend-platforms";
import { AD_PLATFORM_LABELS } from "@/lib/ad-spend-platforms";
import {
  aggregateCampaignPeriodTotals,
  metricsFromCampaignTotals,
  roasFromCampaign,
  shouldIncludeCampaignForDay,
  isActiveCampaignStatus,
  type LiveCampaignRow,
} from "@/lib/ad-campaign-types";
import type { ApiAccountFees } from "@/lib/ad-api-fees";
import { loadSyncAdAccountsForStore } from "@/lib/ad-accounts";
import { convertToBaseCurrency } from "@/lib/fx";
import { formatDateInput, parseDateInput, startOfDay } from "@/lib/period";

export type PlatformAdMetrics = {
  platform: AdPlatform;
  platformLabel: string;
  spend: number;
  impressions: number;
  clicks: number;
  currency: string;
  cpc: number | null;
  ctr: number | null;
  cpm: number | null;
};

export type CampaignDayMetrics = {
  campaignId: string;
  campaignName: string;
  platform: AdPlatform;
  platformLabel: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  roas: number | null;
  currency: string;
  cpc: number | null;
  ctr: number | null;
  cpm: number | null;
  /** Dias desde a primeira aparição na BD (inclusivo). */
  daysRunning?: number;
  /** Conversões acumuladas desde o primeiro dia. */
  lifetimeConversions?: number;
  /** Valor de conversão acumulado desde o primeiro dia. */
  lifetimeConversionValue?: number;
  /** ROAS acumulado desde o primeiro dia. */
  lifetimeRoas?: number | null;
  /** Último estado conhecido (activa/pausada). */
  isActiveCampaign?: boolean;
};

export type StoreAdMetricsBundle = {
  total: {
    spend: number;
    impressions: number;
    clicks: number;
    cpc: number | null;
    ctr: number | null;
    cpm: number | null;
  };
  byPlatform: PlatformAdMetrics[];
  campaigns: CampaignDayMetrics[];
};

export type LoadAdMetricsOptions = {
  /**
   * Filtrar por contas API (ex.: só activas para escala/decisão).
   * Omitir = todo o histórico da loja (finanças/relatórios passados).
   */
  adAccountIds?: string[];
};

function metricsFromTotals(
  spend: number,
  impressions: number,
  clicks: number,
): { cpc: number | null; ctr: number | null; cpm: number | null } {
  return {
    cpc: clicks > 0 ? spend / clicks : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
  };
}

function mapCampaignRow(r: {
  campaignId: string;
  campaignName?: string | null;
  platform: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  currency?: string | null;
}): CampaignDayMetrics {
  const platform = r.platform as AdPlatform;
  const m = metricsFromTotals(r.spend, r.impressions, r.clicks);
  return {
    campaignId: r.campaignId,
    campaignName: r.campaignName?.trim() || "Campanha",
    platform,
    platformLabel: AD_PLATFORM_LABELS[platform] ?? r.platform,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    conversions: r.conversions,
    conversionValue: r.conversionValue,
    roas: roasFromCampaign(r.spend, r.conversionValue),
    currency: r.currency ?? "USD",
    ...m,
  };
}

/** Lê métricas sincronizadas (campanhas + totais por plataforma) a partir da BD. */
export async function loadStoreAdMetricsFromDb(
  storeId: string,
  dateKeys: string[],
  options?: LoadAdMetricsOptions,
): Promise<StoreAdMetricsBundle | null> {
  if (!dateKeys.length) return null;
  if (options?.adAccountIds && options.adAccountIds.length === 0) {
    return {
      total: {
        spend: 0,
        impressions: 0,
        clicks: 0,
        cpc: null,
        ctr: null,
        cpm: null,
      },
      byPlatform: [],
      campaigns: [],
    };
  }

  const storeOid = new mongoose.Types.ObjectId(storeId);
  const query: Record<string, unknown> = {
    storeId: storeOid,
    dateKey: { $in: dateKeys },
  };
  if (options?.adAccountIds?.length) {
    query.adAccountId = {
      $in: options.adAccountIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  const rows = await AdCampaignDay.find(query)
    .select(
      "campaignId campaignName platform adAccountId spend impressions clicks conversions conversionValue currency dateKey",
    )
    .lean();

  if (!rows.length) return null;

  const byCampaignKey = new Map<
    string,
    {
      campaignId: string;
      campaignName: string;
      platform: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      conversionValue: number;
      currency: string;
    }
  >();

  for (const r of rows) {
    const accountPart = r.adAccountId ? String(r.adAccountId) : "legacy";
    const key = `${r.platform}:${accountPart}:${r.campaignId}`;
    const prev = byCampaignKey.get(key);
    if (!prev) {
      byCampaignKey.set(key, {
        campaignId: r.campaignId,
        campaignName: r.campaignName ?? "",
        platform: r.platform,
        spend: r.spend ?? 0,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        conversions: r.conversions ?? 0,
        conversionValue: r.conversionValue ?? 0,
        currency: r.currency ?? "USD",
      });
    } else {
      prev.spend += r.spend ?? 0;
      prev.impressions += r.impressions ?? 0;
      prev.clicks += r.clicks ?? 0;
      prev.conversions += r.conversions ?? 0;
      prev.conversionValue += r.conversionValue ?? 0;
    }
  }

  const campaigns = [...byCampaignKey.values()]
    .map(mapCampaignRow)
    .filter(
      (c) =>
        c.spend > 0 ||
        c.impressions > 0 ||
        c.clicks > 0 ||
        c.conversions > 0,
    )
    .sort((a, b) => b.spend - a.spend);

  const platformAgg = new Map<
    AdPlatform,
    { spend: number; impressions: number; clicks: number; currency: string }
  >();

  for (const c of campaigns) {
    const prev = platformAgg.get(c.platform) ?? {
      spend: 0,
      impressions: 0,
      clicks: 0,
      currency: c.currency,
    };
    prev.spend += c.spend;
    prev.impressions += c.impressions;
    prev.clicks += c.clicks;
    platformAgg.set(c.platform, prev);
  }

  const byPlatform: PlatformAdMetrics[] = [...platformAgg.entries()].map(
    ([platform, v]) => {
      const m = metricsFromTotals(v.spend, v.impressions, v.clicks);
      return {
        platform,
        platformLabel: AD_PLATFORM_LABELS[platform] ?? platform,
        spend: v.spend,
        impressions: v.impressions,
        clicks: v.clicks,
        currency: v.currency,
        ...m,
      };
    },
  );

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0);

  return {
    total: {
      spend: totalSpend,
      impressions: totalImpressions,
      clicks: totalClicks,
      ...metricsFromTotals(totalSpend, totalImpressions, totalClicks),
    },
    byPlatform,
    campaigns,
  };
}

export async function loadStoreAdMetricsForDay(
  storeId: string,
  dateKey: string,
  options?: LoadAdMetricsOptions,
): Promise<StoreAdMetricsBundle | null> {
  return loadStoreAdMetricsFromDb(storeId, [dateKey], options);
}

type DbCampaignRow = {
  dateKey: string;
  campaignId: string;
  campaignName: string;
  platform: AdPlatform;
  adAccountId: string;
  status: string;
  statusLabel: string;
  spendPlatform: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  currency: string;
  syncedAt: Date | null;
};

function applyFeesAndAggregateCampaignRows(
  rows: DbCampaignRow[],
  accountFees: Map<string, ApiAccountFees>,
  accountNames: Map<string, string>,
): LiveCampaignRow[] {
  const dailyAccountSpend = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.dateKey}:${r.adAccountId}`;
    dailyAccountSpend.set(k, (dailyAccountSpend.get(k) ?? 0) + r.spendPlatform);
  }

  const agg = new Map<
    string,
    Omit<LiveCampaignRow, "spendPlatform"> & {
      spendPlatform: number;
      latestDateKey: string;
    }
  >();

  for (const r of rows) {
    const fees = accountFees.get(r.adAccountId) ?? {
      extraFeeFixed: 0,
      agencyFeePercent: 0,
    };
    const dayTotal =
      dailyAccountSpend.get(`${r.dateKey}:${r.adAccountId}`) ?? r.spendPlatform;
    const fixedShare =
      dayTotal > 0 ? (fees.extraFeeFixed * r.spendPlatform) / dayTotal : 0;
    const agencyFee =
      fees.agencyFeePercent > 0
        ? (r.spendPlatform * fees.agencyFeePercent) / 100
        : 0;
    const spendTotal = r.spendPlatform + fixedShare + agencyFee;

    const key = `${r.platform}:${r.campaignId}`;
    const prev = agg.get(key);
    if (!prev) {
      agg.set(key, {
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        platform: r.platform,
        platformLabel: AD_PLATFORM_LABELS[r.platform] ?? r.platform,
        adAccountId: r.adAccountId,
        adAccountName:
          accountNames.get(r.adAccountId)?.trim() ||
          r.adAccountId ||
          r.platform,
        status: r.status || "—",
        statusLabel: r.statusLabel || "—",
        spendPlatform: r.spendPlatform,
        spend: spendTotal,
        impressions: r.impressions,
        clicks: r.clicks,
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        roas: null,
        currency: r.currency,
        cpc: null,
        ctr: null,
        cpm: null,
        latestDateKey: r.dateKey,
      });
      continue;
    }

    prev.spendPlatform += r.spendPlatform;
    prev.spend += spendTotal;
    prev.impressions += r.impressions;
    prev.clicks += r.clicks;
    prev.conversions += r.conversions;
    prev.conversionValue += r.conversionValue;
    if (r.dateKey >= prev.latestDateKey) {
      prev.status = r.status || prev.status;
      prev.statusLabel = r.statusLabel || prev.statusLabel;
      prev.campaignName = r.campaignName || prev.campaignName;
      prev.latestDateKey = r.dateKey;
    }
  }

  return [...agg.values()]
    .map(({ latestDateKey: _d, ...r }) => {
      const spend = Math.round(r.spend * 100) / 100;
      const spendPlatform = Math.round(r.spendPlatform * 100) / 100;
      const conversionValue = Math.round(r.conversionValue * 100) / 100;
      const conversions = Math.round(r.conversions * 100) / 100;
      return {
        ...r,
        spend,
        spendPlatform,
        conversions,
        conversionValue,
        // ROAS / spend: com fees (custo real). CPC/CPM: só plataforma (comparável à Meta/Google).
        roas: roasFromCampaign(spend, conversionValue),
        ...metricsFromCampaignTotals(
          spendPlatform,
          r.impressions,
          r.clicks,
        ),
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

async function convertCampaignRowsToBase(
  rows: LiveCampaignRow[],
  baseCurrency: string,
  fxDateKey: string,
): Promise<LiveCampaignRow[]> {
  const base = baseCurrency.toUpperCase();
  const rateByCurrency = new Map<string, number>();

  async function amountInBase(
    amount: number,
    fromCurrency: string,
  ): Promise<number> {
    if (!amount) return 0;
    const from = fromCurrency.toUpperCase();
    if (from === base) return amount;
    const cached = rateByCurrency.get(from);
    if (cached != null) return Math.round(amount * cached * 100) / 100;
    const fx = await convertToBaseCurrency(amount, from, base, fxDateKey);
    rateByCurrency.set(from, fx.fxRate);
    return fx.amountBase;
  }

  const out: LiveCampaignRow[] = [];
  for (const r of rows) {
    const inputCurrency = (r.currency || "USD").toUpperCase();
    const spendInput = r.spend;
    const spendPlatformInput = r.spendPlatform;
    const conversionValueInput = r.conversionValue;

    if (inputCurrency === base) {
      out.push({
        ...r,
        inputCurrency,
        spendInput,
        spendPlatformInput,
        currency: base,
        roas: roasFromCampaign(spendInput, conversionValueInput),
        ...metricsFromCampaignTotals(
          spendPlatformInput ?? spendInput,
          r.impressions,
          r.clicks,
        ),
      });
      continue;
    }

    const spend = await amountInBase(spendInput, inputCurrency);
    const spendPlatform =
      spendPlatformInput != null
        ? await amountInBase(spendPlatformInput, inputCurrency)
        : undefined;
    const conversionValue = await amountInBase(
      conversionValueInput,
      inputCurrency,
    );

    out.push({
      ...r,
      inputCurrency,
      spendInput,
      spendPlatformInput,
      currency: base,
      spend,
      spendPlatform,
      conversionValue,
      roas: roasFromCampaign(spend, conversionValue),
      ...metricsFromCampaignTotals(
        spendPlatform ?? spend,
        r.impressions,
        r.clicks,
      ),
    });
  }
  return out;
}

/** Campanhas a partir da BD (um ou vários dias), com fees aplicadas por dia. */
export async function loadStoreCampaignsFromDb(
  storeId: string,
  dateKeys: string[],
  accounts: Array<{
    id: string;
    platform: AdPlatform;
    accountName: string;
    externalAccountId: string;
    apiExtraFeeFixed: number;
    apiAgencyFeePercent: number;
  }>,
  options: { baseCurrency: string; fxDateKey: string },
): Promise<{
  campaigns: LiveCampaignRow[];
  syncedAt: string | null;
  daysWithData: number;
}> {
  if (!dateKeys.length) {
    return { campaigns: [], syncedAt: null, daysWithData: 0 };
  }

  const storeOid = new mongoose.Types.ObjectId(storeId);
  const activePlatforms = [...new Set(accounts.map((a) => a.platform))];
  const activeAccountIds = new Set(accounts.map((a) => a.id));

  const rawRows = await AdCampaignDay.find({
    storeId: storeOid,
    dateKey: { $in: dateKeys },
    platform: { $in: activePlatforms },
  })
    .select(
      "dateKey campaignId campaignName platform adAccountId spend impressions clicks conversions conversionValue currency status statusLabel syncedAt",
    )
    .lean();

  const bestByKey = new Map<string, (typeof rawRows)[number]>();
  for (const r of rawRows) {
    const key = `${r.platform}:${r.dateKey}:${r.campaignId}`;
    const accId = r.adAccountId ? String(r.adAccountId) : "";
    const prev = bestByKey.get(key);
    if (!prev) {
      bestByKey.set(key, r);
      continue;
    }
    const prevActive = activeAccountIds.has(
      prev.adAccountId ? String(prev.adAccountId) : "",
    );
    const curActive = activeAccountIds.has(accId);
    if (curActive && !prevActive) {
      bestByKey.set(key, r);
      continue;
    }
    if (curActive === prevActive) {
      const prevTs = prev.syncedAt ? new Date(prev.syncedAt).getTime() : 0;
      const curTs = r.syncedAt ? new Date(r.syncedAt).getTime() : 0;
      if (curTs >= prevTs) bestByKey.set(key, r);
    }
  }

  const rows = [...bestByKey.values()].filter((r) =>
    shouldIncludeCampaignForDay(r.status ?? "", {
      spend: r.spend ?? 0,
      impressions: r.impressions ?? 0,
      clicks: r.clicks ?? 0,
      conversions: r.conversions ?? 0,
    }),
  );

  const accountFees = new Map<string, ApiAccountFees>();
  const accountNames = new Map<string, string>();
  for (const acc of accounts) {
    accountFees.set(acc.id, {
      extraFeeFixed: acc.apiExtraFeeFixed ?? 0,
      agencyFeePercent: acc.apiAgencyFeePercent ?? 0,
    });
    accountNames.set(
      acc.id,
      acc.accountName?.trim() || acc.externalAccountId || acc.platform,
    );
  }

  const daysWithData = new Set(
    rows.map((r) => r.dateKey).filter((k): k is string => Boolean(k)),
  ).size;

  const dbRows: DbCampaignRow[] = rows.map((r) => ({
    dateKey: r.dateKey,
    campaignId: r.campaignId,
    campaignName: r.campaignName?.trim() || "Campanha",
    platform: r.platform as AdPlatform,
    adAccountId: r.adAccountId ? String(r.adAccountId) : "",
    status: r.status ?? "",
    statusLabel: r.statusLabel ?? "",
    spendPlatform: r.spend ?? 0,
    impressions: r.impressions ?? 0,
    clicks: r.clicks ?? 0,
    conversions: r.conversions ?? 0,
    conversionValue: r.conversionValue ?? 0,
    currency: r.currency ?? "USD",
    syncedAt: r.syncedAt ?? null,
  }));

  const campaignsRaw = applyFeesAndAggregateCampaignRows(
    dbRows,
    accountFees,
    accountNames,
  );

  const campaigns = await convertCampaignRowsToBase(
    campaignsRaw,
    options.baseCurrency,
    options.fxDateKey,
  );

  const latestSync = rows.reduce<Date | null>((max, r) => {
    const t = r.syncedAt;
    if (!t) return max;
    return !max || t > max ? t : max;
  }, null);

  return {
    campaigns,
    syncedAt: latestSync?.toISOString() ?? null,
    daysWithData,
  };
}

export type CampaignLifecycle = {
  firstSeenDateKey: string;
  daysRunning: number;
  lifetimeSpend: number;
  lifetimeConversions: number;
  lifetimeConversionValue: number;
  lifetimeRoas: number | null;
  isActive: boolean;
  campaignName: string;
};

function campaignMetricsKey(platform: string, campaignId: string): string {
  return `${platform}:${campaignId}`;
}

function inclusiveDaysBetween(fromKey: string, toKey: string): number {
  const from = parseDateInput(fromKey);
  const to = parseDateInput(toKey);
  if (!from || !to || to < from) return 0;
  return (
    Math.floor(
      (startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000,
    ) + 1
  );
}

/** Histórico por campanha (desde o primeiro dia na BD) — para regras de teste 7/14 dias.
 * Lifetime spend/ROAS incluem fee fixa + % agência da conta (igual ao ROAS do período). */
export async function loadCampaignLifecycleMap(
  storeId: string,
  adAccountIds: string[],
  referenceDateKey = formatDateInput(new Date()),
): Promise<Map<string, CampaignLifecycle>> {
  const out = new Map<string, CampaignLifecycle>();
  if (!adAccountIds.length) return out;

  const storeOid = new mongoose.Types.ObjectId(storeId);
  const accountIdSet = new Set(adAccountIds);
  const accountOids = adAccountIds.map((id) => new mongoose.Types.ObjectId(id));

  const accounts = await loadSyncAdAccountsForStore(storeOid);
  const accountFees = new Map<string, ApiAccountFees>();
  const accountNames = new Map<string, string>();
  for (const acc of accounts) {
    const id = String(acc._id);
    if (!accountIdSet.has(id)) continue;
    accountFees.set(id, {
      extraFeeFixed: acc.apiExtraFeeFixed ?? 0,
      agencyFeePercent: acc.apiAgencyFeePercent ?? 0,
    });
    accountNames.set(
      id,
      acc.accountName?.trim() || acc.externalAccountId || acc.platform,
    );
  }

  const [dayRows, latestRows] = await Promise.all([
    AdCampaignDay.find({
      storeId: storeOid,
      adAccountId: { $in: accountOids },
    })
      .select(
        "dateKey campaignId campaignName platform adAccountId spend conversions conversionValue status currency syncedAt",
      )
      .lean(),
    AdCampaignDay.aggregate<{
      _id: { platform: string; campaignId: string };
      status: string;
      campaignName: string;
    }>([
      { $match: { storeId: storeOid, adAccountId: { $in: accountOids } } },
      { $sort: { dateKey: -1 } },
      {
        $group: {
          _id: { platform: "$platform", campaignId: "$campaignId" },
          status: { $first: "$status" },
          campaignName: { $first: "$campaignName" },
        },
      },
    ]),
  ]);

  const firstSeenByKey = new Map<string, string>();
  for (const r of dayRows) {
    const platform = r.platform as string;
    const key = campaignMetricsKey(platform, r.campaignId);
    const prev = firstSeenByKey.get(key);
    if (!prev || r.dateKey < prev) firstSeenByKey.set(key, r.dateKey);
  }

  const dbRows: DbCampaignRow[] = dayRows.map((r) => ({
    dateKey: r.dateKey,
    campaignId: r.campaignId,
    campaignName: r.campaignName?.trim() || "Campanha",
    platform: r.platform as AdPlatform,
    adAccountId: r.adAccountId ? String(r.adAccountId) : "",
    status: r.status ?? "",
    statusLabel: "",
    spendPlatform: r.spend ?? 0,
    impressions: 0,
    clicks: 0,
    conversions: r.conversions ?? 0,
    conversionValue: r.conversionValue ?? 0,
    currency: r.currency ?? "USD",
    syncedAt: r.syncedAt ?? null,
  }));

  const withFees = applyFeesAndAggregateCampaignRows(
    dbRows,
    accountFees,
    accountNames,
  );

  const latestByKey = new Map(
    latestRows.map((r) => [
      campaignMetricsKey(r._id.platform, r._id.campaignId),
      r,
    ]),
  );

  for (const row of withFees) {
    const key = campaignMetricsKey(row.platform, row.campaignId);
    const latest = latestByKey.get(key);
    const firstSeen = firstSeenByKey.get(key);
    if (!firstSeen) continue;
    out.set(key, {
      firstSeenDateKey: firstSeen,
      daysRunning: inclusiveDaysBetween(firstSeen, referenceDateKey),
      lifetimeSpend: row.spend,
      lifetimeConversions: row.conversions,
      lifetimeConversionValue: row.conversionValue,
      lifetimeRoas: roasFromCampaign(row.spend, row.conversionValue),
      isActive: isActiveCampaignStatus(latest?.status ?? ""),
      campaignName:
        latest?.campaignName?.trim() || row.campaignName || "Campanha",
    });
  }

  return out;
}

/**
 * Campanhas para Decisão: métricas do período + activas recentes (mesmo sem gasto)
 * + lifecycle desde o primeiro dia na BD.
 */
export async function loadStoreCampaignsForDecision(
  storeId: string,
  dateKeys: string[],
  adAccountIds: string[],
  referenceDateKey = formatDateInput(new Date()),
): Promise<CampaignDayMetrics[]> {
  if (!adAccountIds.length || !dateKeys.length) return [];

  const storeOid = new mongoose.Types.ObjectId(storeId);
  const accountOids = adAccountIds.map((id) => new mongoose.Types.ObjectId(id));
  const latestDateKey = [...dateKeys].sort().at(-1)!;

  const [periodBundle, lifecycle, latestDayRows] = await Promise.all([
    loadStoreAdMetricsFromDb(storeId, dateKeys, { adAccountIds }),
    loadCampaignLifecycleMap(storeId, adAccountIds, referenceDateKey),
    AdCampaignDay.find({
      storeId: storeOid,
      dateKey: latestDateKey,
      adAccountId: { $in: accountOids },
    })
      .select(
        "campaignId campaignName platform status spend impressions clicks conversions conversionValue currency",
      )
      .lean(),
  ]);

  const byKey = new Map<string, CampaignDayMetrics>();
  for (const c of periodBundle?.campaigns ?? []) {
    byKey.set(campaignMetricsKey(c.platform, c.campaignId), c);
  }

  for (const r of latestDayRows) {
    if (!isActiveCampaignStatus(r.status ?? "")) continue;
    const platform = r.platform as AdPlatform;
    const key = campaignMetricsKey(platform, r.campaignId);
    if (byKey.has(key)) continue;
    byKey.set(
      key,
      mapCampaignRow({
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        platform,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
        currency: r.currency ?? "USD",
      }),
    );
  }

  return [...byKey.values()]
    .map((c) => {
      const lc = lifecycle.get(campaignMetricsKey(c.platform, c.campaignId));
      return {
        ...c,
        campaignName: c.campaignName || lc?.campaignName || "Campanha",
        daysRunning: lc?.daysRunning,
        lifetimeConversions: lc?.lifetimeConversions,
        lifetimeConversionValue: lc?.lifetimeConversionValue,
        lifetimeRoas: lc?.lifetimeRoas,
        isActiveCampaign: lc?.isActive,
      };
    })
    .sort((a, b) => {
      const aActive = a.isActiveCampaign ? 1 : 0;
      const bActive = b.isActiveCampaign ? 1 : 0;
      if (bActive !== aActive) return bActive - aActive;
      return b.spend - a.spend;
    });
}

export type ReportPlatformAdKpis = {
  platform: AdPlatform;
  platformLabel: string;
  /** Gasto plataforma (sem fees), moeda base. */
  spendPlatform: number;
  cpc: number | null;
  ctr: number | null;
  cpm: number | null;
};

export type ReportAdKpis = {
  cpc: number | null;
  ctr: number | null;
  cpm: number | null;
  currency: string;
  /** Gasto plataforma (sem fees), moeda base. */
  spendPlatform: number;
  byPlatform: ReportPlatformAdKpis[];
};

/**
 * CPC/CPM/CTR para relatórios: gasto plataforma (sem fees), convertido para moeda base.
 */
export async function loadReportAdKpisForPeriod(
  storeId: string,
  dateKeys: string[],
  baseCurrency: string,
): Promise<ReportAdKpis | null> {
  if (!dateKeys.length) return null;

  const storeOid = new mongoose.Types.ObjectId(storeId);
  const accounts = await loadSyncAdAccountsForStore(storeOid);
  if (!accounts.length) return null;

  const fxDateKey = [...dateKeys].sort().at(-1)!;
  const base = baseCurrency.toUpperCase();

  const { campaigns } = await loadStoreCampaignsFromDb(
    storeId,
    dateKeys,
    accounts.map((a) => ({
      id: String(a._id),
      platform: a.platform as AdPlatform,
      accountName: a.accountName?.trim() || a.externalAccountId || a.platform,
      externalAccountId: a.externalAccountId,
      apiExtraFeeFixed: a.apiExtraFeeFixed ?? 0,
      apiAgencyFeePercent: a.apiAgencyFeePercent ?? 0,
    })),
    { baseCurrency: base, fxDateKey },
  );

  const hasActivity = campaigns.some(
    (c) =>
      (c.spendPlatform ?? c.spend) > 0 ||
      c.impressions > 0 ||
      c.clicks > 0,
  );
  if (!hasActivity) return null;

  const total = aggregateCampaignPeriodTotals(campaigns, base);
  const spendPlatform = campaigns.reduce(
    (s, c) => s + (c.spendPlatform ?? c.spend),
    0,
  );

  const byPlatformMap = new Map<AdPlatform, LiveCampaignRow[]>();
  for (const c of campaigns) {
    const list = byPlatformMap.get(c.platform) ?? [];
    list.push(c);
    byPlatformMap.set(c.platform, list);
  }

  const byPlatform: ReportPlatformAdKpis[] = [...byPlatformMap.entries()]
    .map(([platform, rows]) => {
      const t = aggregateCampaignPeriodTotals(rows, base);
      const platformSpend = rows.reduce(
        (s, c) => s + (c.spendPlatform ?? c.spend),
        0,
      );
      return {
        platform,
        platformLabel: AD_PLATFORM_LABELS[platform] ?? platform,
        spendPlatform: platformSpend,
        cpc: t.cpc,
        ctr: t.ctr,
        cpm: t.cpm,
      };
    })
    .filter(
      (p) =>
        p.spendPlatform > 0 || p.cpc != null || p.ctr != null || p.cpm != null,
    )
    .sort((a, b) => b.spendPlatform - a.spendPlatform);

  return {
    cpc: total.cpc,
    ctr: total.ctr,
    cpm: total.cpm,
    currency: base,
    spendPlatform,
    byPlatform,
  };
}
