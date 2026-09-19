import { Package } from "lucide-react";
import { Sensitive } from "@/components/privacy-mode";
import type { TopProduct } from "@/lib/metrics";

export function ProductsProfitTable({
  products,
  mode = "profit",
  /** Dentro de CollapsibleSection — sem cabeçalho nem borda duplicada. */
  embedded = false,
}: {
  products: TopProduct[];
  mode?: "profit" | "units";
  embedded?: boolean;
}) {
  const byUnits = mode === "units";

  return (
    <div
      className={
        embedded ? undefined : "rounded-lg border border-border bg-surface"
      }
    >
      {!embedded && (
        <div className="border-b border-border p-5">
          <h2 className="text-lg font-semibold">
            {byUnits ? "Produtos por unidades vendidas" : "Produtos por lucro"}
          </h2>
          {byUnits ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Modo COGS por encomenda ou por dia — ranking por volume, não por
              margem.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              BER = break-even ROAS (COGS/taxa supplier + taxas; vs ROAS com agência).
            </p>
          )}
        </div>
      )}

      {products.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          Sem produtos no período. Sincroniza a loja.
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-muted-foreground">
                  <th className="px-5 py-3">Produto</th>
                  <th className="px-5 py-3 text-right">Unidades</th>
                  {!byUnits && (
                    <>
                      <th className="px-5 py-3 text-right">Margem</th>
                      <th className="px-5 py-3 text-right">BER</th>
                      <th className="px-5 py-3 text-right">Lucro</th>
                    </>
                  )}
                  {byUnits && <th className="px-5 py-3 text-right">Receita</th>}
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr
                    key={p.title}
                    className="border-t border-border hover:bg-muted"
                  >
                    <td className="px-5 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                          <Package className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <Sensitive className="block truncate font-medium">
                          {p.title}
                        </Sensitive>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      <Sensitive>{p.units}</Sensitive>
                    </td>
                    {!byUnits && (
                      <>
                        <td
                          className={`px-5 py-3 text-right tabular-nums ${p.marginPositive ? "text-positive" : "text-negative"}`}
                        >
                          <Sensitive>{p.margin}</Sensitive>
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          <Sensitive>{p.berRoas}</Sensitive>
                        </td>
                        <td
                          className={`px-5 py-3 text-right tabular-nums ${p.positive ? "text-positive" : "text-negative"}`}
                        >
                          <Sensitive>{p.profit}</Sensitive>
                        </td>
                      </>
                    )}
                    {byUnits && (
                      <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                        <Sensitive>{p.revenue}</Sensitive>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 lg:hidden">
            {products.map((p) => (
              <div
                key={p.title}
                className="rounded-lg border border-border bg-background p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                    <Package className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Sensitive className="font-medium leading-snug">
                      {p.title}
                    </Sensitive>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <Sensitive>{p.units}</Sensitive> unidades
                      {byUnits && (
                        <>
                          {" · "}
                          <Sensitive>{p.revenue}</Sensitive>
                        </>
                      )}
                    </p>
                  </div>
                </div>
                {!byUnits && (
                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Margem</dt>
                      <dd
                        className={`mt-0.5 font-semibold tabular-nums ${p.marginPositive ? "text-positive" : "text-negative"}`}
                      >
                        <Sensitive>{p.margin}</Sensitive>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">BER</dt>
                      <dd className="mt-0.5 font-semibold tabular-nums">
                        <Sensitive>{p.berRoas}</Sensitive>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Lucro</dt>
                      <dd
                        className={`mt-0.5 font-semibold tabular-nums ${p.positive ? "text-positive" : "text-negative"}`}
                      >
                        <Sensitive>{p.profit}</Sensitive>
                      </dd>
                    </div>
                  </dl>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
