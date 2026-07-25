import React, { useState, useMemo, useEffect } from "react";

// ===========================================================================
// LIVE FEED
// ---------------------------------------------------------------------------
// Fetches the weekly JSON your Make "Publish Feed" scenario writes to GitHub.
// The published file keeps Airtable's raw field names (that's what a plain
// Airtable-API export naturally produces), so `adaptFeed` below translates
// that shape into the {leagues, fixtures} shape the rest of this component
// expects. If you ever change what Make exports, this is the one place to
// update — nothing below this block needs to change.
// ===========================================================================

const FEED_URL =
  "https://raw.githubusercontent.com/adamweads-art/pitch_please/main/matchweek.json";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function adaptFeed(raw) {
  const leagues = {};
  for (const rec of raw.leagues || []) {
    const f = rec.fields || {};
    const code = f["Competition Code"];
    if (!code) continue;
    leagues[code] = {
      name: f["League Name"] || code,
      short: f["Short Name"] || code,
      chip: f["Chip Color"] || "#8892A0",
    };
  }

  const fixtures = (raw.fixtures || [])
    .map((rec, i) => {
      const f = rec.fields || {};
      const kickoff = f["Kickoff"] ? new Date(f["Kickoff"]) : null;
      const tags = [f["Rivalry Tag"], ...(f["Tags"] || [])].filter(Boolean);
      return {
        id: f["Fixture ID"] || rec.id || i,
        lg: f["League Code"],
        h: f["Home Team Name"] || "TBD",
        a: f["Away Team Name"] || "TBD",
        day: kickoff ? WEEKDAY[kickoff.getDay()] : "",
        date: kickoff ? String(kickoff.getDate()).padStart(2, "0") : "",
        time: kickoff
          ? kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
          : "",
        _kickoffMs: kickoff ? kickoff.getTime() : 0,
        tags,
        highlightOverride: !!f["Highlight Override"],
        sig: {
          r: f["Rivalry Final"] ?? 40,
          s: f["Stakes Score"] ?? 0,
          f: f["Match Form Score"] ?? 0,
          st: f["Star Power Score"] ?? 0,
        },
      };
    })
    .filter((fx) => fx.lg && leagues[fx.lg])
    .sort((a, b) => a._kickoffMs - b._kickoffMs);

  return {
    label: raw.label || "Pitch, Please",
    eyebrow: raw.generatedAt ? `Updated ${raw.generatedAt}` : "",
    range: raw.range || "This week",
    weights: raw.weights || { r: 35, s: 30, st: 20, f: 15 },
    leagues,
    fixtures,
  };
}

function Loading() {
  return (
    <div className="mw mw-status">
      <style>{CSS}</style>
      <div className="status-box">
        <div className="spinner" />
        <p>Loading this week's matches…</p>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="mw mw-status">
      <style>{CSS}</style>
      <div className="status-box">
        <p className="status-title">Couldn't load the feed</p>
        <p className="status-sub">{message}</p>
        <button className="tune-btn" onClick={onRetry}>Try again</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const DAY_ORDER = ["Fri", "Sat", "Sun", "Mon"];
const DAY_FULL = { Fri: "Friday", Sat: "Saturday", Sun: "Sunday", Mon: "Monday" };

const SIGNAL_META = [
  { key: "r",  label: "Rivalry" },
  { key: "s",  label: "Stakes" },
  { key: "st", label: "Star power" },
  { key: "f",  label: "Form" },
];

function scoreOf(fx, w) {
  const denom = w.r + w.s + w.st + w.f;
  if (denom === 0) return 0;
  const raw = fx.sig.r * w.r + fx.sig.s * w.s + fx.sig.st * w.st + fx.sig.f * w.f;
  return Math.round(raw / denom);
}

// glow intensity 0..1; games below ~52 stay dim
function glow(score) {
  return Math.max(0, Math.min(1, (score - 52) / 45));
}

export default function MatchweekBoard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`${FEED_URL}?t=${Date.now()}`) // cache-bust so you always see this week's file
      .then((r) => {
        if (!r.ok) throw new Error(`Feed returned ${r.status}`);
        return r.json();
      })
      .then((raw) => {
        if (!cancelled) setData(adaptFeed(raw));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Unknown error");
      });
    return () => { cancelled = true; };
  }, [reloadTick]);

  if (error) return <ErrorState message={error} onRetry={() => setReloadTick((t) => t + 1)} />;
  if (!data) return <Loading />;

  const leagueKeys = Object.keys(data.leagues);
  const allOnObj = Object.fromEntries(leagueKeys.map((k) => [k, true]));

  const [active, setActive] = useState(allOnObj);
  const [group, setGroup] = useState("score"); // "score" | "day"
  const [tuning, setTuning] = useState(false);
  const [w, setW] = useState(data.weights);

  const scored = useMemo(
    () => data.fixtures.map((fx) => ({ ...fx, score: scoreOf(fx, w) })),
    [data.fixtures, w]
  );
  const filtered = useMemo(() => scored.filter((fx) => active[fx.lg]), [scored, active]);
  const highlights = useMemo(
    () => [...filtered].sort((a, b) => b.score - a.score).slice(0, 5),
    [filtered]
  );
  const board = useMemo(() => {
    if (group === "score") {
      return [{ key: "all", label: null, items: [...filtered].sort((a, b) => b.score - a.score) }];
    }
    return DAY_ORDER.map((d) => ({
      key: d,
      label: DAY_FULL[d],
      items: filtered.filter((fx) => fx.day === d).sort((a, b) => b.score - a.score),
    })).filter((g) => g.items.length);
  }, [filtered, group]);

  const toggle = (lg) => setActive((s) => ({ ...s, [lg]: !s[lg] }));
  const allOn = leagueKeys.every((k) => active[k]);

  return (
    <div className="mw">
      <style>{CSS}</style>

      <header className="mw-head">
        <div className="mw-eyebrow">{data.eyebrow}</div>
        <h1 className="mw-title">{data.label}</h1>
        <div className="mw-sub">
          <span className="mw-range">{data.range}</span>
          <span className="mw-sample">Sample data</span>
        </div>
        <p className="mw-lede">
          Every game across five leagues, ranked by how worth-watching it is. Turn the dials to
          decide what "worth watching" means to you.
        </p>
      </header>

      <div className="mw-controls">
        <div className="mw-chips">
          <button className={"chip chip-all" + (allOn ? " on" : "")} onClick={() => setActive(allOnObj)}>
            All
          </button>
          {leagueKeys.map((id) => {
            const l = data.leagues[id];
            return (
              <button key={id} onClick={() => toggle(id)}
                className={"chip" + (active[id] ? " on" : "")}
                style={active[id] ? { "--c": l.chip } : {}}>
                <span className="dot" style={{ background: l.chip }} />
                {l.short}
              </button>
            );
          })}
        </div>

        <div className="mw-right">
          <div className="seg">
            <button className={group === "score" ? "on" : ""} onClick={() => setGroup("score")}>Ranked</button>
            <button className={group === "day" ? "on" : ""} onClick={() => setGroup("day")}>By day</button>
          </div>
          <button className={"tune-btn" + (tuning ? " on" : "")} onClick={() => setTuning((t) => !t)}>
            Tune scoring
          </button>
        </div>
      </div>

      {tuning && (
        <div className="mw-tuner">
          <div className="tuner-head">
            <span>What makes a game worth watching?</span>
            <button className="reset" onClick={() => setW(data.weights)}>Reset</button>
          </div>
          <div className="sliders">
            {SIGNAL_META.map((m) => (
              <label key={m.key} className="slider">
                <div className="slider-top">
                  <span>{m.label}</span>
                  <span className="slider-val">{w[m.key]}</span>
                </div>
                <input type="range" min="0" max="100" value={w[m.key]}
                  onChange={(e) => setW((s) => ({ ...s, [m.key]: Number(e.target.value) }))} />
              </label>
            ))}
          </div>
        </div>
      )}

      {highlights.length > 0 && data.fixtures.length > 0 && (
        <section className="mw-hl">
          <h2 className="mw-h2"><span className="lamp" />Under the floodlights</h2>
          <div className="hl-grid">
            {highlights.map((fx, i) => <HotCard key={fx.id} fx={fx} league={data.leagues[fx.lg]} rank={i + 1} />)}
          </div>
        </section>
      )}

      <section className="mw-list">
        <h2 className="mw-h2 muted">The full slate</h2>
        {board.map((g) => (
          <div key={g.key} className="grp">
            {g.label && <div className="grp-label">{g.label}</div>}
            <div className="rows">
              {g.items.map((fx) => <Row key={fx.id} fx={fx} league={data.leagues[fx.lg]} />)}
            </div>
          </div>
        ))}
        {filtered.length === 0 && data.fixtures.length === 0 && (
          <div className="empty">
            Nothing on the calendar right now — the feed updates every Tuesday, and fixtures will
            appear here as soon as each league's schedule is announced.
          </div>
        )}
        {filtered.length === 0 && data.fixtures.length > 0 && (
          <div className="empty">No leagues selected. Switch one back on to see its fixtures.</div>
        )}
      </section>

      <footer className="mw-foot">
        <p>
          Score = a weighted blend of four signals per game: rivalry, table stakes, star power and
          recent form. In production these come from API-Football, and this exact blend becomes your
          Airtable formula.
        </p>
      </footer>
    </div>
  );
}

function Meter({ sig }) {
  return (
    <div className="meter" aria-hidden>
      {SIGNAL_META.map((m) => (
        <div key={m.key} className="meter-col" title={m.label}>
          <div className="meter-track"><div className="meter-fill" style={{ height: sig[m.key] + "%" }} /></div>
          <span className="meter-lab">{m.label[0]}</span>
        </div>
      ))}
    </div>
  );
}

function HotCard({ fx, league, rank }) {
  const g = glow(fx.score);
  return (
    <article className="hot" style={{ "--g": g, "--c": league.chip }}>
      <div className="hot-top">
        <span className="lg-tag" style={{ color: league.chip }}>
          <span className="dot" style={{ background: league.chip }} />{league.short}
        </span>
        <span className="rank">No. {rank}</span>
      </div>
      <div className="hot-teams">
        <span>{fx.h}</span>
        <span className="v">v</span>
        <span>{fx.a}</span>
      </div>
      <div className="hot-tags">
        {fx.tags.map((t) => <span key={t} className="tag">{t}</span>)}
      </div>
      <div className="hot-bottom">
        <span className="kick">{fx.day} · {fx.time}</span>
        <span className="readout">{fx.score}</span>
      </div>
    </article>
  );
}

function Row({ fx, league }) {
  const g = glow(fx.score);
  return (
    <div className="row" style={{ "--g": g }}>
      <span className="row-lg" style={{ background: league.chip }} title={league.name} />
      <div className="row-main">
        <div className="row-teams">{fx.h} <span className="v">v</span> {fx.a}</div>
        <div className="row-tags">{fx.tags.map((t) => <span key={t} className="tag sm">{t}</span>)}</div>
      </div>
      <span className="row-kick">{fx.day}<br />{fx.time}</span>
      <Meter sig={fx.sig} />
      <span className="row-score readout">{fx.score}</span>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=Spline+Sans+Mono:wght@500;600&display=swap');

.mw {
  --bg:#0B1512; --panel:#10201B; --card:#152621; --line:rgba(238,242,236,0.10);
  --line2:rgba(238,242,236,0.20); --chalk:#EEF2EC; --muted:#7E938A;
  --amber:#F2A94A; --amber-soft:#F7CE96;
  font-family:'Barlow',system-ui,sans-serif; color:var(--chalk);
  background:
    radial-gradient(120% 90% at 80% -10%, rgba(242,169,74,0.10), transparent 55%),
    radial-gradient(120% 90% at 10% -10%, rgba(89,167,230,0.06), transparent 50%),
    var(--bg);
  min-height:100%; padding:34px clamp(16px,4vw,44px) 60px;
  box-sizing:border-box; -webkit-font-smoothing:antialiased;
}
.mw *{box-sizing:border-box;}

.mw-eyebrow{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.28em;
  font-size:12px;font-weight:600;color:var(--amber);opacity:.9;}
.mw-title{font-family:'Barlow Condensed';font-weight:700;letter-spacing:-.01em;
  font-size:clamp(46px,9vw,84px);line-height:.9;margin:6px 0 8px;text-transform:uppercase;}
.mw-sub{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
.mw-range{font-family:'Barlow Condensed';font-size:20px;font-weight:600;color:var(--chalk);letter-spacing:.02em;}
.mw-sample{font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--muted);
  border:1px solid var(--line2);border-radius:20px;padding:3px 10px;}
.mw-lede{max-width:56ch;color:var(--muted);font-size:15px;line-height:1.5;margin:14px 0 0;}

.mw-controls{display:flex;justify-content:space-between;align-items:center;gap:16px;
  flex-wrap:wrap;margin:30px 0 4px;padding-bottom:18px;border-bottom:1px solid var(--line);}
.mw-chips{display:flex;gap:8px;flex-wrap:wrap;}
.chip{font-family:'Barlow Condensed';font-weight:600;font-size:15px;letter-spacing:.02em;
  color:var(--muted);background:transparent;border:1px solid var(--line2);border-radius:22px;
  padding:7px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;
  transition:.18s ease;text-transform:uppercase;}
.chip:hover{color:var(--chalk);border-color:var(--chalk);}
.chip.on{color:#0B1512;background:var(--c,var(--chalk));border-color:var(--c,var(--chalk));}
.chip-all.on{background:var(--chalk);border-color:var(--chalk);}
.chip .dot{width:8px;height:8px;border-radius:50%;flex:none;}
.chip.on .dot{display:none;}

.mw-right{display:flex;gap:10px;align-items:center;}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:22px;overflow:hidden;}
.seg button{font-family:'Barlow Condensed';text-transform:uppercase;font-weight:600;font-size:14px;
  letter-spacing:.04em;background:transparent;color:var(--muted);border:none;padding:7px 15px;cursor:pointer;}
.seg button.on{background:var(--chalk);color:#0B1512;}
.tune-btn{font-family:'Barlow Condensed';text-transform:uppercase;font-weight:600;font-size:14px;
  letter-spacing:.04em;background:transparent;color:var(--amber);border:1px solid rgba(242,169,74,.5);
  border-radius:22px;padding:7px 15px;cursor:pointer;transition:.18s;}
.tune-btn:hover,.tune-btn.on{background:var(--amber);color:#0B1512;border-color:var(--amber);}

.mw-tuner{margin-top:18px;background:var(--panel);border:1px solid var(--line2);border-radius:14px;padding:18px 20px;}
.tuner-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;
  font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.06em;font-weight:600;font-size:15px;}
.reset{background:none;border:none;color:var(--muted);text-decoration:underline;cursor:pointer;
  font-family:'Barlow';font-size:12px;letter-spacing:0;text-transform:none;}
.reset:hover{color:var(--chalk);}
.sliders{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:18px 26px;}
.slider-top{display:flex;justify-content:space-between;font-size:13px;color:var(--muted);
  margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-family:'Barlow Condensed';font-weight:600;}
.slider-val{font-family:'Spline Sans Mono';color:var(--amber);}
.slider input{width:100%;-webkit-appearance:none;height:3px;border-radius:3px;background:var(--line2);outline:none;}
.slider input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;
  background:var(--amber);cursor:pointer;box-shadow:0 0 10px rgba(242,169,74,.6);}
.slider input::-moz-range-thumb{width:16px;height:16px;border:none;border-radius:50%;
  background:var(--amber);cursor:pointer;box-shadow:0 0 10px rgba(242,169,74,.6);}

.mw-h2{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.06em;font-weight:700;
  font-size:22px;margin:36px 0 16px;display:flex;align-items:center;gap:10px;}
.mw-h2.muted{color:var(--muted);}
.lamp{width:12px;height:12px;border-radius:50%;background:var(--amber);box-shadow:0 0 14px 2px rgba(242,169,74,.75);}

.hl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;}
.hot{position:relative;background:linear-gradient(165deg,var(--card),#101d19);
  border:1px solid var(--line2);border-radius:16px;padding:18px 18px 16px;overflow:hidden;
  border-top:2px solid rgba(242,169,74,calc(.25 + var(--g)*.75));
  box-shadow:0 calc(2px + var(--g)*14px) calc(14px + var(--g)*34px) rgba(242,169,74,calc(var(--g)*.16));
  transition:transform .18s ease;}
.hot:hover{transform:translateY(-3px);}
.hot-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.lg-tag{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.1em;font-weight:600;
  font-size:12px;display:inline-flex;align-items:center;gap:6px;}
.lg-tag .dot{width:7px;height:7px;border-radius:50%;}
.rank{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.1em;font-size:11px;color:var(--muted);}
.hot-teams{font-family:'Barlow Condensed';font-weight:700;font-size:26px;line-height:1.05;
  letter-spacing:-.01em;display:flex;flex-direction:column;gap:1px;}
.hot-teams .v{color:var(--muted);font-weight:500;font-size:15px;margin:1px 0;}
.hot-tags{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 16px;}
.tag{font-size:11px;letter-spacing:.04em;color:var(--amber-soft);
  border:1px solid rgba(242,169,74,.32);border-radius:20px;padding:3px 9px;white-space:nowrap;}
.tag.sm{color:var(--muted);border-color:var(--line2);}
.hot-bottom{display:flex;justify-content:space-between;align-items:flex-end;margin-top:2px;}
.kick{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.08em;font-size:13px;color:var(--muted);}
.readout{font-family:'Spline Sans Mono';font-weight:600;color:var(--amber);
  text-shadow:0 0 calc(var(--g)*16px) rgba(242,169,74,calc(var(--g)*.9));}
.hot .readout{font-size:40px;line-height:1;}

.mw-list{margin-top:8px;}
.grp{margin-bottom:22px;}
.grp-label{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.14em;font-size:13px;
  color:var(--amber);margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line);}
.rows{display:flex;flex-direction:column;gap:1px;}
.row{display:grid;grid-template-columns:4px 1fr auto auto 52px;gap:16px;align-items:center;
  background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;transition:border-color .15s;}
.row:hover{border-color:var(--line2);}
.row-lg{width:4px;height:38px;border-radius:3px;align-self:center;}
.row-teams{font-family:'Barlow Condensed';font-weight:600;font-size:19px;letter-spacing:.01em;}
.row-teams .v{color:var(--muted);font-weight:500;font-size:14px;padding:0 3px;}
.row-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:3px;}
.row-kick{font-family:'Barlow Condensed';text-align:right;font-size:14px;color:var(--muted);
  line-height:1.15;letter-spacing:.04em;text-transform:uppercase;}
.row-score{font-size:26px;text-align:right;}

.meter{display:flex;gap:5px;align-items:flex-end;}
.meter-col{display:flex;flex-direction:column;align-items:center;gap:4px;}
.meter-track{width:5px;height:30px;background:var(--line);border-radius:3px;display:flex;align-items:flex-end;overflow:hidden;}
.meter-fill{width:100%;background:linear-gradient(180deg,var(--amber),rgba(242,169,74,.45));border-radius:3px;}
.meter-lab{font-size:9px;color:var(--muted);font-family:'Spline Sans Mono';}

.empty{color:var(--muted);padding:30px 0;text-align:center;font-size:15px;max-width:52ch;margin:0 auto;line-height:1.6;}

.mw-status{display:flex;align-items:center;justify-content:center;min-height:280px;}
.status-box{text-align:center;max-width:40ch;}
.status-title{font-family:'Barlow Condensed';font-weight:700;font-size:20px;text-transform:uppercase;
  letter-spacing:.04em;margin:0 0 8px;}
.status-sub{color:var(--muted);font-size:14px;margin:0 0 18px;}
.spinner{width:34px;height:34px;border-radius:50%;margin:0 auto 18px;
  border:3px solid var(--line2);border-top-color:var(--amber);animation:spin 0.8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none;}}
.mw-foot{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);}
.mw-foot p{color:var(--muted);font-size:13px;line-height:1.6;max-width:70ch;margin:0;}

@media (max-width:620px){
  .row{grid-template-columns:4px 1fr 46px;grid-auto-rows:auto;}
  .row-kick{grid-column:2;text-align:left;}
  .meter{grid-column:2;}
  .row-score{grid-row:1;grid-column:3;}
}
@media (prefers-reduced-motion:reduce){ .hot{transition:none;} }
`;
