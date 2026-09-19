import "server-only";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { DailyNote } from "@/models/DailyNote";
import { resolveStoreAdMetricsForDay } from "@/lib/ad-insights";
import { loadReportAdKpisForPeriod } from "@/lib/ad-campaign-metrics";
import { loadActiveAdAccountIdsForStore } from "@/lib/ad-accounts";
import { buildWorkspacePnl } from "@/lib/metrics";
import { storeBerRoas } from "@/lib/profit";
import {
  buildCampaignDecisions,
  pickBestCampaign,
} from "@/lib/campaign-decision";
import { roasFromCampaign } from "@/lib/ad-campaign-types";
import { startOfDay, endOfDay, parseDateInput } from "@/lib/period";
import { Store } from "@/models/Store";

function isApiAutoObs(obs: string | undefined | null): boolean {
  const t = (obs ?? "").trim();
  return t.startsWith("[Ads API");
}

/** Preenche snapshot API na nota diária (métricas + melhor campanha). */
export async function syncApiMetricsToDailyNote(
  workspaceId: string,
  storeId: string,
  dateKey: string,
): Promise<void> {
  await connectToDatabase();
  const activeAccountIds = await loadActiveAdAccountIdsForStore(storeId);
  const metrics = await resolveStoreAdMetricsForDay(storeId, dateKey, {
    adAccountIds: activeAccountIds,
  });
  if (!metrics) return;

  const day = parseDateInput(dateKey);
  if (!day) return;
  const noteDate = startOfDay(day);
  const dayEnd = endOfDay(noteDate);

  let storeBer: number | null = null;
  let storeRevenue: number | undefined;
  let storeAdSpend: number | undefined;
  try {
    const pnl = await buildWorkspacePnl(workspaceId, { dates: dateKey }, storeId);
    const storeLine = pnl.stores[0];
    storeBer = storeLine
      ? storeBerRoas(storeLine)
      : storeBerRoas(pnl.totals);
    storeRevenue = storeLine?.revenue;
    storeAdSpend = storeLine?.adSpend ?? metrics.total.spend;
  } catch {
    /* BER opcional — não bloqueia nota */
  }

  const campaignRows = buildCampaignDecisions(metrics.campaigns, {
    storeBer,
    storeRevenue,
    totalAdSpend: storeAdSpend ?? metrics.total.spend,
  });
  const best = pickBestCampaign(campaignRows);

  const conversionValue = metrics.campaigns.reduce(
    (s, c) => s + c.conversionValue,
    0,
  );
  const conversions = metrics.campaigns.reduce((s, c) => s + c.conversions, 0);
  const roas = roasFromCampaign(metrics.total.spend, conversionValue);

  const storeDoc = await Store.findById(storeId).select("currency").lean();
  const baseCurrency = storeDoc?.currency ?? "EUR";
  const reportKpis = await loadReportAdKpisForPeriod(
    storeId,
    [dateKey],
    baseCurrency,
  );
  const currency = reportKpis?.currency ?? baseCurrency;

  const wsOid = new mongoose.Types.ObjectId(workspaceId);
  const storeOid = new mongoose.Types.ObjectId(storeId);

  const apiSnapshot = {
    spend: metrics.total.spend,
    clicks: metrics.total.clicks,
    impressions: metrics.total.impressions,
    conversions,
    conversionValue,
    roas,
    cpc: reportKpis?.cpc ?? metrics.total.cpc,
    ctr: reportKpis?.ctr ?? metrics.total.ctr,
    cpm: reportKpis?.cpm ?? metrics.total.cpm,
    currency,
    bestCampaign: best?.name ?? "",
    campaignSuggestion: "",
    syncedAt: new Date(),
  };

  const existing = await DailyNote.findOne({
    workspaceId: wsOid,
    storeId: storeOid,
    date: { $gte: noteDate, $lte: dayEnd },
  });

  if (existing) {
    const update: Record<string, unknown> = { apiSnapshot };
    if (isApiAutoObs(existing.reportFields?.obs)) {
      update["reportFields.obs"] = "";
    }
    await DailyNote.updateOne({ _id: existing._id }, { $set: update });
  } else {
    await DailyNote.create({
      workspaceId: wsOid,
      storeId: storeOid,
      date: noteDate,
      didScale: false,
      text: "",
      apiSnapshot,
    });
  }
}
