import Link from "next/link";
import { can, getBriefing, getHomeLayout, HERO_RANGES, isChartPeriod, isWidget, type HeroRange, type WidgetId } from "@bos/core";
import { ModeSwitch } from "../../components/ModeSwitch";
import { BriefingPanel } from "../../components/BriefingPanel";
import { Widget, WIDGET_INFO } from "../../components/home/widgets";
import { assistantConfigured } from "../../lib/assistant";
import { requireSession } from "../../lib/session";
import { changeHome } from "./home-actions";
import { zone, todayHere } from "../../lib/locale";

const greeting = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

/** The list of cards a person can add, or swap an existing card for. */
function WidgetMenu({ options, replacing }: { options: WidgetId[]; replacing: WidgetId | null }) {
  return (
    <div className="glass widget-menu" role="region" aria-label={replacing ? `Replace ${WIDGET_INFO[replacing].name}` : "Add a card"}>
      <div className="panel-head">
        <div>
          <h2 className="title">{replacing ? `Replace "${WIDGET_INFO[replacing].name}" with` : "Add a widget"}</h2>
          <div className="muted">{options.length ? "Pick what you want to see here." : "Everything available to your role is already on your dashboard."}</div>
        </div>
        <Link href="/?edit=1" className="btn btn-glass btn-small" scroll={false}>
          Close
        </Link>
      </div>
      <form action={changeHome} className="widget-options">
        <input type="hidden" name="kind" value={replacing ? "replace" : "add"} />
        {replacing && <input type="hidden" name="id" value={replacing} />}
        {options.map((id) => {
          const info = WIDGET_INFO[id];
          return (
            <button type="submit" className="widget-option" name={replacing ? "with" : "id"} value={id} key={id}>
              <span className={`widget-thumb widget-thumb-${info.size}`} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="row-text">
                <span className="row-title">{info.name}</span>
                <span className="muted">{info.about}</span>
              </span>
              <span className="badge">{info.size === "full" ? "Full width" : info.size === "wide" ? "Wide" : "Compact"}</span>
            </button>
          );
        })}
      </form>
    </div>
  );
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ edit?: string; add?: string; replace?: string; range?: string; chart?: string; error?: string }> }) {
  const { ctx, membership } = await requireSession();
  const params = await searchParams;
  const edit = params.edit === "1";
  const requested = Number(params.range);
  const range: HeroRange = (HERO_RANGES as readonly number[]).includes(requested) ? (requested as HeroRange) : 30;
  const view = { range, chart: params.chart && isChartPeriod(params.chart) ? params.chart : ("30d" as const), edit };
  const [layout, briefing] = await Promise.all([getHomeLayout(ctx, membership.businessType), assistantConfigured() ? getBriefing(ctx) : null]);
  const replacing = edit && params.replace && isWidget(params.replace) && layout.widgets.includes(params.replace) ? params.replace : null;
  const adding = edit && params.add === "1";

  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: zone() }).format(now));
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zone() }).format(now);

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{today}</div>
          <h1>
            {greeting(hour)}, <span className="dim">{membership.userName.split(" ")[0]}</span>
          </h1>
        </div>
        {edit ? (
          <>
            {layout.customized && (
              <form action={changeHome}>
                <input type="hidden" name="kind" value="reset" />
                <button type="submit" className="btn btn-glass">
                  Reset to default
                </button>
              </form>
            )}
            <ModeSwitch />
            <Link href="/" className="btn btn-primary">
              Done
            </Link>
          </>
        ) : (
          <>
            <Link href="/?edit=1" className="btn btn-glass">
              Customize
            </Link>
            {can(ctx, "sales_order.write") && (
              <Link href="/sales/new" className="btn btn-primary">
                New order
              </Link>
            )}
          </>
        )}
      </header>
      {params.error && <p className="error">{params.error}</p>}
      {edit && (
        <p className="notice notice-edit">You are arranging your own Home screen. Move, replace or remove cards, or add new ones. Other people keep their own layout.</p>
      )}

      {!edit && assistantConfigured() && (
        <BriefingPanel
          initial={briefing?.body ?? ""}
          done={briefing?.done ?? []}
          day={todayHere()}
          writtenAt={briefing ? `at ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone() }).format(briefing.writtenAt)}` : ""}
        />
      )}

      <div className="dash">
        {layout.widgets.map((id, index) => {
          const info = WIDGET_INFO[id];
          return (
            <div className={`dash-item dash-${info.size} ${edit ? "is-editing" : ""}`} key={id}>
              {edit && (
                <div className="widget-bar">
                  <span className="widget-name">{info.name}</span>
                  <span className="widget-tools">
                    {([[-1, "earlier", "‹"], [1, "later", "›"]] as const).map(([by, word, glyph]) => (
                      <form action={changeHome} key={by}>
                        <input type="hidden" name="kind" value="move" />
                        <input type="hidden" name="id" value={id} />
                        <input type="hidden" name="by" value={by} />
                        <button type="submit" className="icon-button" aria-label={`Move ${info.name} ${word}`} disabled={by === -1 ? index === 0 : index === layout.widgets.length - 1}>
                          {glyph}
                        </button>
                      </form>
                    ))}
                    <Link href={`/?edit=1&replace=${id}`} className="btn btn-glass btn-small" scroll={false}>
                      Replace
                    </Link>
                    <form action={changeHome}>
                      <input type="hidden" name="kind" value="remove" />
                      <input type="hidden" name="id" value={id} />
                      <button type="submit" className="btn btn-glass btn-small">
                        Remove
                      </button>
                    </form>
                  </span>
                </div>
              )}
              {replacing === id && <WidgetMenu options={layout.available} replacing={id} />}
              <Widget id={id} ctx={ctx} view={view} />
            </div>
          );
        })}
        <div className="dash-item dash-full">
          {adding ? (
            <WidgetMenu options={layout.available} replacing={null} />
          ) : (
            <Link href="/?edit=1&add=1" className={`widget-add ${edit ? "" : "widget-add-slim"}`} scroll={false}>
              <span aria-hidden="true">+</span>
              <span>Add a widget</span>
            </Link>
          )}
        </div>
        {layout.widgets.length === 0 && !adding && (
          <section className="glass panel dash-item dash-full empty">
            <div className="empty-title">Your dashboard is empty</div>
            <p>Choose Add a widget to put cards here.</p>
          </section>
        )}
      </div>
    </>
  );
}
