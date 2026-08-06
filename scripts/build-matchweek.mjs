#!/usr/bin/env node
/**
 * Pitch, Please - weekly feed builder
 *
 * Reads config.json, fetches standings and fixtures from football-data.org
 * and ESPN, scores every fixture, and writes matchweek.json.
 *
 * Replaces the two Make scenarios and the Airtable base entirely. There is no
 * database in the middle, so there are no operation quotas, API-call caps or
 * record limits to run into.
 *
 * Env:
 *   FOOTBALL_DATA_TOKEN  required for the football-data.org leagues
 *
 * Usage:
 *   node scripts/build-matchweek.mjs            # writes matchweek.json
 *   node scripts/build-matchweek.mjs --dry-run  # prints a summary, writes nothing
 */

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const OUTPUT_PATH = path.join(ROOT, "matchweek.json");

const DRY_RUN = process.argv.includes("--dry-run");
const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN || "";

const FD_BASE = "https://api.football-data.org/v4";
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_CORE = "https://site.api.espn.com/apis/v2/sports/soccer";

// football-data.org free tier allows 10 requests/minute. Space calls out so a
// full run never trips it, even with every league switched on.
const FD_DELAY_MS = 6500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function getJSON(url, headers = {}, label = "") {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${label || url} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

let lastFdCall = 0;
async function fdGet(pathAndQuery, label) {
  const wait = FD_DELAY_MS - (Date.now() - lastFdCall);
  if (wait > 0) await sleep(wait);
  lastFdCall = Date.now();
  return getJSON(`${FD_BASE}${pathAndQuery}`, { "X-Auth-Token": FD_TOKEN }, label);
}

// ---------------------------------------------------------------------------
// Scoring. These mirror the Airtable formulas exactly.
// ---------------------------------------------------------------------------

/** 1st = 100, last = 0. Neutral 50 when we have no table. */
function positionScore(position, teamsInLeague) {
  if (!position || !teamsInLeague || teamsInLeague < 2) return 50;
  return Math.round(100 - ((position - 1) / (teamsInLeague - 1)) * 100);
}

/** "W,D,L,W,W" or "WDLWW" -> 0-100. Ignores separators. */
function formScore(form) {
  if (!form) return 0;
  const s = String(form).toUpperCase();
  const w = (s.match(/W/g) || []).length;
  const d = (s.match(/D/g) || []).length;
  return Math.round(((w * 3 + d) / 15) * 100);
}

/** Payroll rank scaled between the league's floor and ceiling. */
function starPowerAuto(rank, league) {
  const { starCeiling: hi, starFloor: lo, teamsInLeague: n } = league;
  if (!rank || !n || n < 2) return lo;
  return Math.round(hi - ((rank - 1) / (n - 1)) * (hi - lo));
}

/** Rewards both teams being high (70%) and being close together (30%). */
function stakesScore(homePos, awayPos) {
  return Math.round(0.7 * ((homePos + awayPos) / 2) + 0.3 * (100 - Math.abs(homePos - awayPos)));
}

/** Weighted toward the bigger club, so one giant still lifts a fixture. */
function starPowerScore(a, b) {
  return Math.round(0.6 * Math.max(a, b) + 0.4 * Math.min(a, b));
}

function watchability({ rivalry, stakes, star, form }, weights) {
  const total = weights.r + weights.s + weights.st + weights.f;
  return Math.round(
    (weights.r * rivalry + weights.s * stakes + weights.st * star + weights.f * form) / total
  );
}

// ---------------------------------------------------------------------------
// Rivalry lookup, order independent
// ---------------------------------------------------------------------------

function buildRivalryIndex(rivalries) {
  const idx = new Map();
  for (const r of rivalries) {
    const [a, b] = r.teams;
    idx.set(`${a}|${b}`, r);
    idx.set(`${b}|${a}`, r);
  }
  return idx;
}

function lookupRivalry(idx, home, away, fallback) {
  const hit = idx.get(`${home}|${away}`);
  return hit ? { score: hit.score, tag: hit.tag } : { score: fallback, tag: null };
}

// ---------------------------------------------------------------------------
// Source adapters. Each returns a common shape so the scorer doesn't care
// which API the data came from.
//   teams:    Map name -> { name, crest, position, form }
//   fixtures: [{ id, utcDate, homeName, awayName }]
// ---------------------------------------------------------------------------

async function loadFootballData(league, windowDays) {
  const teams = new Map();

  if (league.pullStandings) {
    const q = league.standingsSeason ? `?season=${league.standingsSeason}` : "";
    const data = await fdGet(
      `/competitions/${league.competitionCode}/standings${q}`,
      `${league.code} standings`
    );
    // standings[] holds TOTAL, HOME, AWAY in that order; TOTAL is what we want.
    const table = data?.standings?.[0]?.table || [];
    for (const row of table) {
      const name = row.team?.shortName || row.team?.name;
      if (!name) continue;
      teams.set(name, {
        name,
        crest: row.team?.crest || "",
        position: row.position,
        form: row.form || "",
      });
    }
  }

  const from = new Date();
  const to = new Date(Date.now() + windowDays * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({ dateFrom: fmt(from), dateTo: fmt(to) });
  if (league.fixtureSeason) params.set("season", String(league.fixtureSeason));

  const md = await fdGet(
    `/competitions/${league.competitionCode}/matches?${params}`,
    `${league.code} fixtures`
  );

  const fixtures = (md.matches || []).map((m) => ({
    id: String(m.id),
    utcDate: m.utcDate,
    homeName: m.homeTeam?.shortName || m.homeTeam?.name || "TBD",
    awayName: m.awayTeam?.shortName || m.awayTeam?.name || "TBD",
  }));

  return { teams, fixtures };
}

async function loadEspn(league, windowDays) {
  const teams = new Map();

  if (league.pullStandings) {
    const data = await getJSON(
      `${ESPN_CORE}/${league.espnSlug}/standings`,
      {},
      `${league.code} standings`
    );
    // ESPN nests the table under children[0]; entries arrive already sorted,
    // and carry no rank stat, so position comes from array order.
    const entries = data?.children?.[0]?.standings?.entries || data?.standings?.entries || [];
    entries.forEach((e, i) => {
      const name = e.team?.displayName;
      if (!name) return;
      teams.set(name, {
        name,
        crest: e.team?.logo || (e.team?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${e.team.id}.png` : ""),
        position: i + 1,
        form: "", // ESPN standings carry no recent-form string
      });
    });
  }

  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const dates = `${fmt(new Date())}-${fmt(new Date(Date.now() + windowDays * 864e5))}`;
  const sb = await getJSON(
    `${ESPN_SITE}/${league.espnSlug}/scoreboard?dates=${dates}&limit=200`,
    {},
    `${league.code} fixtures`
  );

  const fixtures = (sb.events || []).map((ev) => {
    const comps = ev.competitions?.[0]?.competitors || [];
    const home = comps.find((c) => c.homeAway === "home") || comps[0];
    const away = comps.find((c) => c.homeAway === "away") || comps[1];
    return {
      id: `mx${ev.id}`,
      utcDate: ev.date,
      homeName: home?.team?.displayName || "TBD",
      awayName: away?.team?.displayName || "TBD",
    };
  });

  return { teams, fixtures };
}


// ---------------------------------------------------------------------------
// Choosing which fixtures to publish
//
// The fetch window is deliberately wide so leagues starting weeks from now are
// still discovered. What gets *published* is narrower, and controlled by
// config.publishMode:
//
//   "weekend" - just the next Fri-Mon block of football (the default). Midweek
//               fixtures are excluded, which is the point.
//   "days"    - anchor on the earliest fixture and take config.publishDays
//               forward from there. Use this if you want midweek games too.
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * The Fri 00:00 - Mon 23:59 block (UTC) that a given date belongs to.
 * Fri/Sat/Sun/Mon map to the block they sit in. Tue/Wed/Thu roll forward to
 * the coming Friday, since a midweek game isn't part of a weekend.
 */
function weekendBlockFor(date) {
  const d = new Date(date);
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  const backToFriday = { 5: 0, 6: 1, 0: 2, 1: 3 };
  const shift = dow in backToFriday ? backToFriday[dow] : -((5 - dow + 7) % 7);
  const start = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - shift, 0, 0, 0, 0
  ));
  const end = new Date(start.getTime() + 4 * 864e5 - 1); // through Mon 23:59:59
  return { start, end };
}

function formatRange(start, end) {
  const f = (d) => `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
  return `${f(start)} - ${f(end)}`;
}

function selectPublished(fixtures, config) {
  if (!fixtures.length) return { published: [], rangeLabel: "" };

  const mode = config.publishMode || "weekend";

  if (mode === "days") {
    const anchor = new Date(fixtures[0].kickoff).getTime();
    const cutoff = anchor + (config.publishDays ?? 9) * 864e5;
    const published = fixtures.filter((f) => new Date(f.kickoff).getTime() <= cutoff);
    return { published, rangeLabel: "" };
  }

  // Weekend mode. Walk forward through fixtures until we find one that sits in
  // a weekend block containing actual games, so an all-midweek round (or a
  // stray friendly on a Wednesday) doesn't produce an empty board.
  for (const fx of fixtures) {
    const { start, end } = weekendBlockFor(fx.kickoff);
    const inBlock = fixtures.filter((f) => {
      const t = new Date(f.kickoff).getTime();
      return t >= start.getTime() && t <= end.getTime();
    });
    if (inBlock.length) {
      return { published: inBlock, rangeLabel: formatRange(start, end) };
    }
  }

  // Nothing landed on a weekend at all; fall back to everything we have rather
  // than publishing an empty feed.
  return { published: fixtures, rangeLabel: "" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const active = config.leagues.filter((l) => l.active);

  if (!active.length) throw new Error("No active leagues in config.json");
  if (active.some((l) => l.source === "football-data") && !FD_TOKEN) {
    throw new Error("FOOTBALL_DATA_TOKEN is not set but football-data leagues are active");
  }

  log(`Building feed for ${active.length} league(s): ${active.map((l) => l.code).join(", ")}`);

  const rivalryIndex = buildRivalryIndex(config.rivalries || []);
  const overrides = config.starPowerOverrides || {};
  const allFixtures = [];
  const leaguesOut = [];

  for (const league of active) {
    let loaded;
    try {
      loaded = league.source === "espn"
        ? await loadEspn(league, config.windowDays)
        : await loadFootballData(league, config.windowDays);
    } catch (err) {
      // One bad league shouldn't kill the whole run. Skip it and carry on so
      // the other leagues still publish.
      warn(`${league.code} failed, skipping: ${err.message}`);
      continue;
    }

    const { teams, fixtures } = loaded;
    log(`  ${league.code}: ${teams.size} teams, ${fixtures.length} fixtures`);

    leaguesOut.push({
      code: league.code,
      name: league.name,
      short: league.short,
      chip: league.chip,
    });

    // Payroll rank -> star power, per team, for this league.
    const rankList = (config.payrollRanks || {})[league.code] || [];
    const rankOf = new Map(rankList.map((n, i) => [n, i + 1]));

    const starOf = (name) => {
      if (overrides[name] != null) return overrides[name];
      return starPowerAuto(rankOf.get(name), league);
    };

    for (const fx of fixtures) {
      const home = teams.get(fx.homeName);
      const away = teams.get(fx.awayName);

      const hPos = positionScore(home?.position, league.teamsInLeague);
      const aPos = positionScore(away?.position, league.teamsInLeague);
      const hStar = starOf(fx.homeName);
      const aStar = starOf(fx.awayName);
      const hForm = formScore(home?.form);
      const aForm = formScore(away?.form);

      const rivalry = lookupRivalry(
        rivalryIndex, fx.homeName, fx.awayName, config.defaultRivalry ?? 40
      );

      const sig = {
        r: rivalry.score,
        s: stakesScore(hPos, aPos),
        st: starPowerScore(hStar, aStar),
        f: Math.round((hForm + aForm) / 2),
      };

      allFixtures.push({
        id: fx.id,
        lg: league.code,
        h: fx.homeName,
        a: fx.awayName,
        hCrest: home?.crest || "",
        aCrest: away?.crest || "",
        kickoff: fx.utcDate,
        tags: rivalry.tag ? [rivalry.tag] : [],
        sig,
        score: watchability(
          { rivalry: sig.r, stakes: sig.s, star: sig.st, form: sig.f },
          config.weights
        ),
      });
    }
  }

  if (!allFixtures.length) {
    warn("No fixtures found in the window. Writing an empty feed rather than failing.");
  }

  // Anchor on the earliest upcoming fixture, then keep ~9 days from there, so
  // the board always shows "the next matchweek" rather than whatever happens
  // to fall inside a fixed window.
  allFixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const { published, rangeLabel } = selectPublished(allFixtures, config);

  const feed = {
    label: "Pitch, Please",
    generatedAt: new Date().toISOString().slice(0, 10),
    weights: config.weights,
    range: rangeLabel,
    leagues: leaguesOut.filter((l) => published.some((f) => f.lg === l.code)),
    fixtures: published,
  };

  log(`\n${published.length} fixtures published (of ${allFixtures.length} in window)`);
  if (published.length) {
    log(`Window: ${published[0].kickoff.slice(0, 10)} to ${published.at(-1).kickoff.slice(0, 10)}`);
    log("\nTop 5 by watchability:");
    [...published].sort((a, b) => b.score - a.score).slice(0, 5)
      .forEach((f) => log(`  ${String(f.score).padStart(3)}  ${f.lg.padEnd(4)} ${f.h} v ${f.a}`));
  }

  if (DRY_RUN) {
    log("\nDry run, nothing written.");
    return;
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(feed), "utf8");
  log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});
