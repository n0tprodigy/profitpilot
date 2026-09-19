import "server-only";
import { storeBerRoas as calcStoreBerRoas } from "@/lib/profit";
import { formatCurrency, formatPercent } from "@/lib/utils";
import {
  buildStoreProductRanking,
  buildWorkspacePnl,
  type TopProduct,
} from "@/lib/metrics";
import { buildWorkspaceTreasury, type WorkspaceTreasury } from "@/lib/treasury";
import type { PeriodInput } from "@/lib/period";
import type { StoreAccess } from "@/lib/store-access";
import { loadSyncAdAccountsForStore } from "@/lib/ad-accounts";
import { Types } from "mongoose";
import {
  buildCampaignDecisionAnalysis,
  type CampaignAnalysisWindow,
} from "@/lib/campaign-analysis";
import { listRecentScaleEvents } from "@/lib/campaign-scale";
import { listRecentPauseEvents } from "@/lib/campaign-pause";
import type { AdPlatform } from "@/lib/ad-spend-platforms";
import type {
  CampaignDecisionAnalysis,
  CampaignDecisionRow,
  DecisionRow,
  DecisionStatus,
  DecisionSummary,
  RecentPauseEvent,
  TodayAction,
} from "@/lib/decision-types";

export type {
  CampaignDecisionRow,
  DecisionRow,
  DecisionStatus,
  DecisionSummary,
  TodayAction,
} from "@/lib/decision-types";
export { parseAnalysisWindow } from "@/lib/decision-types";

function statusLabel(status: DecisionStatus): string {
  if (status === "scale") return "Scale";
  if (status === "kill") return "Kill";
  return "Manter";
}

function productStatus(marginPct: number, positive: boolean): DecisionStatus {
  if (!positive || marginPct < 0) return "kill";
  if (marginPct >= 15 && positive) return "scale";
  return "maintain";
}

function storeStatus(
  margin: number,
  netProfit: number,
  roas: number | null,
  ber: number | null,
): DecisionStatus {
  if (netProfit < 0 || margin < 0) return "kill";
  if (roas != null && ber != null && roas >= ber * 1.1 && margin >= 10) return "scale";
  return "maintain";
}

function parseMarginPct(margin: string): number {
  const n = Number.parseFloat(margin.replace("%", "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function buildProductRows(products: TopProduct[]): DecisionRow[] {
  return products.map((p) => {
    const marginPct = parseMarginPct(p.margin);
    const status = productStatus(marginPct, p.positive);
    return {
      name: p.title,
      kind: "product",
      status,
      statusLabel: statusLabel(status),
      roas: "—",
      ber: p.berRoas,
      margin: p.margin,
      spend: "—",
    };
  });
}

function buildStoreRows(
  currency: string,
  stores: Awaited<ReturnType<typeof buildWorkspacePnl>>["stores"],
  adSpendByStore: Map<string, number>,
): DecisionRow[] {
  return stores.map((s) => {
    const ber = calcStoreBerRoas(s);
    const roas = s.adSpend > 0 ? s.revenue / s.adSpend : null;
    const status = storeStatus(s.margin, s.netProfit, roas, ber);
    return {
      name: s.name,
      kind: "store",
      status,
      statusLabel: statusLabel(status),
      roas: roas != null ? roas.toFixed(2).replace(".", ",") : "—",
      ber: ber != null ? ber.toFixed(2).replace(".", ",") : "—",
      margin: formatPercent(s.margin),
      spend: formatCurrency(s.adSpend, currency),
    };
  });
}

function buildCampaignActions(rows: CampaignDecisionRow[]): TodayAction[] {
  const actions: TodayAction[] = [];
  const kill = rows.find((r) => r.status === "kill" || r.status === "pause");
  if (kill) {
    actions.push({
      level: "negative",
      text: `${kill.name} (${kill.adAccountName}) — ${kill.statusLabel}. ${kill.reason}`,
    });
  }
  const scale = rows.find((r) => r.status === "scale" && r.hasFullWindow);
  if (scale) {
    actions.push({
      level: "positive",
      text: `${scale.name} (${scale.adAccountName}) — scale. ${scale.reason}`,
    });
  }
  const testing = rows.filter((r) => r.status === "testing");
  if (testing.length > 0 && !kill) {
    actions.push({
      level: "warning",
      text: `${testing.length} campanha(s) ainda sem ${testing[0]?.spendDaysRequired ?? 7} dias com gasto — aguarda janela completa.`,
    });
  }
  return actions;
}

function buildTodayActions(input: {
  rows: DecisionRow[];
  campaignRows: CampaignDecisionRow[];
  treasury: WorkspaceTreasury | null;
  storeId?: string;
  missingAdSpendDays: number;
  cogsIncomplete: boolean;
}): TodayAction[] {
  const actions: TodayAction[] = [];

  if (input.campaignRows.length) {
    actions.push(...buildCampaignActions(input.campaignRows));
  }

  const scaleRows = input.rows.filter((r) => r.status === "scale");
  if (scaleRows[0]) {
    actions.push({
      level: "positive",
      text: `${scaleRows[0].name} com margem saudável — considera escalar (+10–15% budget se tesouraria permitir).`,
    });
  }

  const killRows = input.rows.filter((r) => r.status === "kill");
  if (killRows[0]) {
    actions.push({
      level: "negative",
      text: `${killRows[0].name} em prejuízo — rever preço, COGS ou pausar ads.`,
    });
  }

  if (input.missingAdSpendDays > 0) {
    actions.push({
      level: "warning",
      text: `Ad spend em falta em ${input.missingAdSpendDays} dia(s) — preenche em Anúncios para decisões fiáveis.`,
    });
  }

  if (input.cogsIncomplete) {
    actions.push({
      level: "warning",
      text: "COGS incompleto — o lucro e o BER podem estar distorcidos.",
    });
  }

  const cashOnHand = input.storeId
    ? input.treasury?.stores.find((s) => s.storeId === input.storeId)?.cashOnHand
    : input.treasury?.totals.cashOnHand;

  if (cashOnHand != null && cashOnHand < 0) {
    actions.push({
      level: "negative",
      text: "Tesouraria apertada — evita aumentar budget até entrar payout.",
    });
  } else if (
    input.treasury &&
    (input.storeId
      ? input.treasury.stores.find((s) => s.storeId === input.storeId)?.available
      : input.treasury.totals.available) === 0 &&
    input.treasury.totals.incoming > 0
  ) {
    actions.push({
      level: "warning",
      text: "Saldo disponível baixo face ao que está a caminho — confirma tesouraria.",
    });
  }

  if (actions.length === 0) {
    actions.push({
      level: "positive",
      text: "Sem alertas críticos — mantém o ritmo e monitoriza o BER.",
    });
  }

  return actions.slice(0, 3);
}

function treasuryCard(
  treasury: WorkspaceTreasury,
  storeId?: string,
): DecisionSummary["treasury"] {
  const line = storeId
    ? treasury.stores.find((s) => s.storeId === storeId)
    : null;
  const view = line ?? treasury.totals;

  return {
    available: line?.availableFmt ?? treasury.totals.availableFmt,
    incoming: line?.incomingFmt ?? treasury.totals.incomingFmt,
    payable: line?.receivedFmt ?? treasury.totals.receivedFmt,
    projected: line?.cashOnHandFmt ?? treasury.totals.cashOnHandFmt,
    projectedTitle: line?.cashOnHandTitle ?? treasury.totals.cashOnHandTitle,
    currency: treasury.currency,
  };
}

export async function buildDecisionSummary(
  workspaceId: string,
  storeId?: string,
  periodInput?: PeriodInput,
  storeAccess: StoreAccess = "all",
  analysisWindowDays: CampaignAnalysisWindow = 7,
): Promise<DecisionSummary> {
  const [pnl, treasury, productRanking] = await Promise.all([
    buildWorkspacePnl(workspaceId, periodInput, storeId, storeAccess),
    buildWorkspaceTreasury(workspaceId, storeId, storeAccess).catch(() => null),
    storeId
      ? buildStoreProductRanking(workspaceId, storeId, periodInput, 20)
      : Promise.resolve(null),
  ]);

  let campaignAnalysis: CampaignDecisionAnalysis | null = null;
  let campaignRows: CampaignDecisionRow[] = [];
  let storeBerRoas: string | null = null;
  let recentScales: Awaited<ReturnType<typeof listRecentScaleEvents>> = [];
  let recentPauses: RecentPauseEvent[] = [];

  if (storeId) {
    const storeLine = pnl.stores[0];
    const storeBer = storeLine
      ? calcStoreBerRoas(storeLine)
      : calcStoreBerRoas(pnl.totals);
    const storeName =
      productRanking?.storeName ?? storeLine?.name ?? "Loja";
    const accounts = await loadSyncAdAccountsForStore(
      new Types.ObjectId(storeId),
    );
    const adAccounts = accounts.map((a) => ({
      id: String(a._id),
      name: a.accountName?.trim() || a.externalAccountId || a.platform,
      platform: a.platform as AdPlatform,
    }));

    if (adAccounts.length) {
      campaignAnalysis = await buildCampaignDecisionAnalysis({
        storeId,
        storeName,
        windowDays: analysisWindowDays,
        adAccounts,
        storeBer,
        currency: pnl.currency,
      });
      campaignRows = campaignAnalysis.sections.flatMap((s) => s.rows);
      storeBerRoas = campaignAnalysis.storeBerRoas;
    }

    recentScales = await listRecentScaleEvents(storeId, 15);
    recentPauses = await listRecentPauseEvents(storeId, 15);
  }

  let rows: DecisionRow[];
  if (storeId && productRanking && productRanking.products.length > 0) {
    rows = buildProductRows(productRanking.products);
  } else {
    const adMap = new Map(pnl.stores.map((s) => [s.name, s.adSpend]));
    rows = buildStoreRows(pnl.currency, pnl.stores, adMap);
  }

  rows.sort((a, b) => {
    const order: Record<DecisionStatus, number> = { kill: 0, maintain: 1, scale: 2 };
    return order[a.status] - order[b.status];
  });

  const actions = buildTodayActions({
    rows,
    campaignRows,
    treasury,
    storeId,
    missingAdSpendDays: pnl.missingAdSpendDays,
    cogsIncomplete: pnl.cogsIncomplete,
  });

  return {
    scopeName: storeId
      ? (productRanking?.storeName ?? pnl.stores[0]?.name ?? null)
      : null,
    periodLabel: `${analysisWindowDays} dias com gasto`,
    actions,
    rows,
    campaignRows,
    campaignAnalysis,
    analysisWindowDays,
    recentScales,
    recentPauses,
    storeBerRoas,
    agentExport: campaignAnalysis?.agentExport ?? null,
    treasury: treasury ? treasuryCard(treasury, storeId) : null,
    generatedAt: new Date().toISOString(),
  };
}
