"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProfitChart, ProfitChartSkeleton, profitChartSingleDayHasContent } from "@/components/dashboard/profit-chart";
import { MonthlyGoalsCard } from "@/components/dashboard/monthly-goals-card";
import { CostBreakdownPanel } from "@/components/dashboard/cost-breakdown-panel";
import { DailyReportPanel } from "@/components/dashboard/daily-report-panel";
import { ShopifyExtraFeesLoader } from "@/components/dashboard/shopify-extra-fees-loader";
import { DataWarnings } from "@/components/dashboard/data-warnings";
import { OperationsAlertsBanner } from "@/components/operations/operations-alerts-banner";
import { DashboardKpiSection } from "@/components/dashboard/dashboard-kpi-section";
import {
  StoreDashboardView,
  StoreDashboardHeader,
} from "@/components/dashboard/store-dashboard-view";
import { StoresComparisonTable } from "@/components/dashboard/stores-comparison-table";
import { WorkspacesComparisonTable } from "@/components/dashboard/workspaces-comparison-table";
import { Sensitive } from "@/components/privacy-mode";
import { useWorkspace } from "@/components/workspace-context";
import {
  periodFromSearchParams,
  periodQueryFromSearchParams,
} from "@/lib/period";
import { parsePortfolioParam } from "@/lib/portfolio-scope";
import type { DashboardSummary } from "@/lib/metrics";
import type { PortfolioSummary } from "@/lib/portfolio-metrics";
import {
  LIVE_DATA_POLL_MS,
} from "@/lib/ad-sync-constants";
import { withLiveFreshParam } from "@/lib/refresh-live-queries";
import { DashboardLiveActions } from "@/components/dashboard/dashboard-live-actions";
import { hrefWithScopeAndStore } from "@/lib/scope-query";
import { cn } from "@/lib/utils";

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-7xl animate-pulse space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="h-8 w-40 rounded-lg bg-muted" />
        <div className="h-5 w-28 rounded bg-muted/70" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[88px] rounded-lg border border-border bg-muted/80"
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 p-1 lg:col-span-2 sm:p-0">
          <ProfitChartSkeleton />
        </div>
        <div className="h-64 rounded-lg bg-muted/40" />
      </div>
    </div>
  );
}

function summaryApiUrl(periodQs: string, storeId: string | null): string {
  const q = new URLSearchParams(periodQs);
  if (storeId) q.set("store", storeId);
  const qs = q.toString();
  return qs ? `/api/metrics/summary?${qs}` : "/api/metrics/summary";
}

function portfolioApiUrl(periodQs: string, portfolio: string | null): string {
  const q = new URLSearchParams(periodQs);
  if (portfolio) q.set("portfolio", portfolio);
  return `/api/metrics/portfolio?${q.toString()}`;
}

async function fetchSummary(
  periodQs: string,
  storeId: string | null,
): Promise<DashboardSummary> {
  const res = await fetch(withLiveFreshParam(summaryApiUrl(periodQs, storeId)), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Falha ao carregar os dados.");
  return res.json();
}

function ChartAndCostsSection({
  showSkeleton,
  chartData,
  chartSeries,
  costBreakdown,
}: {
  showSkeleton: boolean;
  chartData: NonNullable<DashboardSummary["profitChart"]>;
  chartSeries?: DashboardSummary["profitChartSeries"];
  costBreakdown?: DashboardSummary["costBreakdown"] | null;
}) {
  const singleDay = chartData.length === 1;
  const showChart =
    showSkeleton ||
    chartData.length === 0 ||
    chartData.length > 1 ||
    profitChartSingleDayHasContent(chartData);

  if (!showChart && costBreakdown) {
    return (
      <div className="max-w-xl">
        <CostBreakdownPanel data={costBreakdown} omitAnchors />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3 lg:gap-6">
      <div className="min-w-0 lg:col-span-2">
        {showSkeleton ? (
          <ProfitChartSkeleton />
        ) : (
          <ProfitChart data={chartData} series={chartSeries} />
        )}
      </div>
      {costBreakdown && (
        <CostBreakdownPanel data={costBreakdown} omitAnchors={singleDay} />
      )}
    </div>
  );
}

async function fetchPortfolio(
  periodQs: string,
  portfolio: string | null,
): Promise<PortfolioSummary> {
  const res = await fetch(withLiveFreshParam(portfolioApiUrl(periodQs, portfolio)), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Falha ao carregar o portfolio.");
  return res.json();
}

export function DashboardClient() {
  const { workspaceId } = useWorkspace();
  const searchParams = useSearchParams();
  const storeId = searchParams.get("store");
  const portfolioParam = searchParams.get("portfolio");
  const isPortfolio = parsePortfolioParam(portfolioParam) !== null;
  const period = periodFromSearchParams(searchParams);
  const periodQs = periodQueryFromSearchParams(searchParams);
  const adsHref = hrefWithScopeAndStore("/anuncios", searchParams, workspaceId);
  // Evita hydration mismatch: SSR e 1.º paint do cliente iguais (skeleton).
  // Depois do mount, sessionStorage / RQ cache podem preencher os dados.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { data, isError, isFetching, isPending } = useQuery<
    DashboardSummary | PortfolioSummary
  >({
    queryKey: isPortfolio
      ? ["portfolio-summary", portfolioParam, period.key, periodQs]
      : ["metrics-summary", workspaceId, storeId, period.key, periodQs],
    queryFn: ({ queryKey }) => {
      const qs = String(queryKey[queryKey.length - 1]);
      return isPortfolio
        ? fetchPortfolio(qs, portfolioParam)
        : fetchSummary(qs, storeId);
    },
    staleTime: LIVE_DATA_POLL_MS - 10_000,
    refetchInterval: LIVE_DATA_POLL_MS,
  });

  /** Skeleton só no 1.º carregamento — refetch em background mantém o gráfico (preserva Lucro/Faturação + Total). */
  const showChartSkeleton = isPending && !data;

  const portfolioData =
    data && "portfolioMode" in data ? (data as PortfolioSummary) : null;
  const workspaceData =
    data && !("portfolioMode" in data) ? (data as DashboardSummary) : null;

  const isStoreView = Boolean(workspaceData?.scopeName);
  const headerTitle =
    workspaceData?.scopeDomain ?? workspaceData?.scopeName ?? "Dashboard";

  const liveActions = <DashboardLiveActions />;

  const fetchingDim =
    Boolean(data) && isFetching && !isPending
      ? "opacity-[0.92] transition-opacity duration-150"
      : "";

  if (!mounted || isPending) {
    return (
      <DashboardSkeleton />
    );
  }

  if (isPortfolio) {
    return (
      <div className={cn("mx-auto max-w-7xl space-y-4", fetchingDim)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Portfolio
            </h1>
            {portfolioData?.portfolioLabel ? (
              <p className="text-sm text-muted-foreground">
                <Sensitive as="span">{portfolioData.portfolioLabel}</Sensitive>
              </p>
            ) : null}
          </div>
          {liveActions}
        </div>

        {isError && (
          <p className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
            Não foi possível carregar o portfolio. A tentar novamente…
          </p>
        )}

        {portfolioData && (
          <>
            <OperationsAlertsBanner
              exclusionNote={portfolioData.operationContext?.exclusionNote}
              collectionReminders={
                portfolioData.operationContext?.collectionReminders
              }
            />
            <DataWarnings
              cogsIncomplete={portfolioData.cogsIncomplete}
              missingCogsCount={portfolioData.missingCogsCount}
              missingCogsMessage={portfolioData.missingCogsMessage}
              missingAdSpendDays={0}
              adsHref={adsHref}
            />
          </>
        )}

        <DashboardKpiSection
          kpis={portfolioData?.kpis ?? []}
          extendedKpis={portfolioData?.extendedKpis ?? []}
          variant="workspace"
          emphasizeLabel="Net Profit"
        />

        <ChartAndCostsSection
          showSkeleton={showChartSkeleton}
          chartData={portfolioData?.profitChart ?? []}
          costBreakdown={portfolioData?.costBreakdown}
        />

        <WorkspacesComparisonTable
          workspaces={portfolioData?.workspaces ?? []}
          displayCurrency={portfolioData?.displayCurrency ?? "EUR"}
        />
      </div>
    );
  }

  return (
    <div className={cn("mx-auto max-w-7xl space-y-4", fetchingDim)}>
      {isStoreView && workspaceData ? (
        <>
          <StoreDashboardHeader
            title={headerTitle}
            actions={liveActions}
          />
          {isError && (
            <p className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
              Não foi possível carregar os dados. A tentar novamente…
            </p>
          )}
          {workspaceData && (
            <>
              <OperationsAlertsBanner
                exclusionNote={workspaceData.operationContext?.exclusionNote}
                scopedStoreStatus={
                  workspaceData.operationContext?.scopedStoreStatus
                }
                collectionReminders={
                  workspaceData.operationContext?.collectionReminders
                }
              />
              <DataWarnings
                cogsIncomplete={workspaceData.cogsIncomplete}
                missingCogsCount={workspaceData.missingCogsCount}
                missingCogsMessage={workspaceData.missingCogsMessage}
                missingAdSpendDays={0}
                adsHref={adsHref}
              />
              {workspaceData.monthlyGoals && (
                <MonthlyGoalsCard goals={workspaceData.monthlyGoals} />
              )}
            </>
          )}
          <StoreDashboardView data={workspaceData} />
          {storeId && <ShopifyExtraFeesLoader storeId={storeId} />}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              Dashboard
            </h1>
            {liveActions}
          </div>

          {isError && (
            <p className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
              Não foi possível carregar os dados. A tentar novamente…
            </p>
          )}

          {workspaceData && workspaceData.stores.length === 0 && (
            <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Este workspace ainda não tem lojas ligadas. Os valores abaixo estão
              a zero.
            </p>
          )}

          {workspaceData && (
            <>
              <OperationsAlertsBanner
                exclusionNote={workspaceData.operationContext?.exclusionNote}
                collectionReminders={
                  workspaceData.operationContext?.collectionReminders
                }
              />
              <DataWarnings
                cogsIncomplete={workspaceData.cogsIncomplete}
                missingCogsCount={workspaceData.missingCogsCount}
                missingCogsMessage={workspaceData.missingCogsMessage}
                missingAdSpendDays={0}
                adsHref={adsHref}
              />
            </>
          )}

          <DashboardKpiSection
            kpis={workspaceData?.kpis ?? []}
            extendedKpis={workspaceData?.extendedKpis ?? []}
            variant="workspace"
            emphasizeLabel="Net Profit"
          />

          <ChartAndCostsSection
            showSkeleton={showChartSkeleton}
            chartData={workspaceData?.profitChart ?? []}
            chartSeries={workspaceData?.profitChartSeries}
            costBreakdown={workspaceData?.costBreakdown}
          />

          {workspaceData?.monthlyGoals && (
            <MonthlyGoalsCard goals={workspaceData.monthlyGoals} />
          )}

          <StoresComparisonTable stores={workspaceData?.stores ?? []} />

          <DailyReportPanel />
        </>
      )}
    </div>
  );
}
