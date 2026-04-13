"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE (single instance outside component) ─────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const AUTO_REFRESH_SEC = 60;
const MANAGE_PASSWORD  = process.env.NEXT_PUBLIC_MANAGE_PASSWORD || "augusta2025";
const ESPN_URL         = "/api/espn";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function scoreDisplay(score) {
  if (score === null || score === undefined) return "-";
  if (score === 0) return "E";
  return score > 0 ? "+" + score : "" + score;
}
function scoreClass(score) {
  if (score === null || score === undefined) return "score-neutral";
  if (score < 0) return "score-under";
  if (score > 0) return "score-over";
  return "score-even";
}

// ─── NAME MATCHING ────────────────────────────────────────────────────────────
function normaliseName(name) {
  return name.toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, "").trim();
}
function nameSimilarity(a, b) {
  const na = normaliseName(a), nb = normaliseName(b);
  if (na === nb) return 1;
  const lastA = na.split(" ").pop(), lastB = nb.split(" ").pop();
  if (lastA === lastB && lastA.length > 3) return 0.9;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  return 0;
}
function findBestMatch(pickName, espnPlayers) {
  let best = null, bestScore = 0;
  for (const p of espnPlayers) {
    const sim = nameSimilarity(pickName, p.espnName);
    if (sim > bestScore) { bestScore = sim; best = p; }
  }
  return bestScore >= 0.8 ? best : null;
}

// ─── ESPN FETCHER ─────────────────────────────────────────────────────────────
async function fetchGolferScores(golferNames) {
  let data = null;
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ESPN_URL);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      if (json.events) { data = json; break; }
    } catch (e) {
      lastError = e.message;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  if (!data) throw new Error("ESPN unavailable: " + lastError);

const competitors = data?.events?.[0]?.competitions?.[0]?.competitors ?? [];

const tournamentStatus = data?.events?.[0]?.status?.type?.name ?? "";
const tournamentComplete = tournamentStatus === "STATUS_FINAL";


// Work out if the cut has happened before mapping players
const maxRoundsPlayed = competitors.reduce((max, c) => {
  const validRounds = (c.linescores ?? []).filter(r => r.value > 0 || r.displayValue !== "-").length;
  return Math.max(max, validRounds);
}, 0);
const cutHasHappened = maxRoundsPlayed >= 3;
console.log("Cut check — max rounds:", maxRoundsPlayed, "cut happened:", cutHasHappened);


const espnPlayers = competitors.map((c) => {
  const athlete = c.athlete ?? {};
  const rawScore = c.score ?? "0";
  const score = rawScore === "E" ? 0 : (parseInt(rawScore, 10) || 0);

  // ESPN adds placeholder rounds with value:0 and displayValue:"-" for missed cut players
// Count only rounds that have actually been played
const roundsPlayed = (c.linescores ?? []).filter(
  r => r.value > 0 || r.displayValue !== "-"
).length;
const missedCut = cutHasHappened && roundsPlayed <= 2 && score > 0;
const isWinner = c.order === 1 && roundsPlayed === 4 && tournamentComplete;



    // Round scores from linescores — each has period (1-4) and displayValue like "-6", "E"
    const rounds = [null, null, null, null];
    for (const round of (c.linescores ?? [])) {
      const idx = (round.period ?? 0) - 1;
      if (idx >= 0 && idx <= 3) {
        const dv = round.displayValue ?? "";
        rounds[idx] = dv === "E" ? 0 : (parseInt(dv, 10) || null);
      }
    }

    return {
      espnName: (athlete.displayName ?? athlete.fullName ?? "").trim(),
      score,
      missedCut,
isWinner,
      position: c.status?.displayValue ?? "-",
      rounds,
    };
  });

  const result = {};
  for (const name of golferNames) {
    const match = findBestMatch(name, espnPlayers);
    result[name] = match
      ? { score: match.score, missedCut: match.missedCut, isWinner: match.isWinner, position: match.position, rounds: match.rounds }
      : { score: 0, missedCut: false,  isWinner: false,position: "-", rounds: [null, null, null, null] };
  }
  return result;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function MastersLeaderboard() {
  const [picks, setPicks]               = useState([]);
  const [scores, setScores]             = useState({});
  const [loading, setLoading]           = useState(false);
  const [picksLoading, setPicksLoading] = useState(true);
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [countdown, setCountdown]       = useState(AUTO_REFRESH_SEC);
  const [view, setView]                 = useState("leaderboard");
  const [editingPick, setEditingPick]   = useState(null);
  const [editForm, setEditForm]         = useState({ name: "", golfers: ["", "", "", ""] });
  const [error, setError]               = useState(null);
  const [dbError, setDbError]           = useState(null);
  const [scoresLoaded, setScoresLoaded] = useState(false);
  const [expandedId, setExpandedId]     = useState(null);
  const [saving, setSaving]             = useState(false);
  const [manageUnlocked, setManageUnlocked] = useState(false);
  const [pwInput, setPwInput]           = useState("");
  const [pwError, setPwError]           = useState(false);
  const countdownRef = useRef(null);
  const refreshRef   = useRef(null);
  const hasFetchedRef = useRef(false);

  // ── Load picks from Supabase ──
  const loadPicks = useCallback(async () => {
    setPicksLoading(true);
    setDbError(null);
    try {
      const { data, error } = await supabase
        .from("picks")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      setPicks(data.map((row) => ({
        id: row.id,
        name: row.name,
        golfers: [row.golfer1 || "", row.golfer2 || "", row.golfer3 || "", row.golfer4 || ""],
      })));
    } catch (e) {
      setDbError("Could not load picks from database.");
    } finally {
      setPicksLoading(false);
    }
  }, []);

  useEffect(() => { loadPicks(); }, [loadPicks]);

  // ── Save / update pick ──
  const savePick = async () => {
    setSaving(true);
    setDbError(null);
    const row = {
      name: editForm.name,
      golfer1: editForm.golfers[0] || "",
      golfer2: editForm.golfers[1] || "",
      golfer3: editForm.golfers[2] || "",
      golfer4: editForm.golfers[3] || "",
    };
    try {
      if (editingPick === "new") {
        const { error } = await supabase.from("picks").insert([row]);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("picks").update(row).eq("id", editingPick);
        if (error) throw error;
      }
      await loadPicks();
      setEditingPick(null);
    } catch (e) {
      setDbError("Could not save picks. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // ── Delete pick ──
  const deletePick = async (id) => {
    setDbError(null);
    try {
      const { error } = await supabase.from("picks").delete().eq("id", id);
      if (error) throw error;
      await loadPicks();
    } catch (e) {
      setDbError("Could not delete pick.");
    }
  };

  // ── Score refresh ──
  const refreshScores = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const allGolfers = [...new Set(picks.flatMap((p) => p.golfers).filter(Boolean))];
      if (allGolfers.length === 0) return;
      const result = await fetchGolferScores(allGolfers);
      setScores(result);
      setLastUpdated(new Date());
      setScoresLoaded(true);
    } catch (e) {
      setError("Could not reach ESPN. Will retry next cycle.");
    } finally {
      if (!silent) setLoading(false);
      setCountdown(AUTO_REFRESH_SEC);
    }
  }, [picks]);

  // ── Fetch scores once after picks load ──
  useEffect(() => {
    if (picks.length > 0 && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      refreshScores(false);
    }
  }, [picks]); // eslint-disable-line

  // ── Auto-refresh every 60s ──
  useEffect(() => {
    clearInterval(refreshRef.current);
    refreshRef.current = setInterval(() => {
      if (picks.length > 0) refreshScores(true);
    }, AUTO_REFRESH_SEC * 1000);
    return () => clearInterval(refreshRef.current);
  }, []); // eslint-disable-line

  // ── Countdown ticker ──
  useEffect(() => {
    clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => (c <= 1 ? AUTO_REFRESH_SEC : c - 1));
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [lastUpdated]);

  // ── Compute friend totals ──
  const friendTotals = picks
    .map((pick) => {
      let total = 0, hasScores = false;
      const golferDetails = pick.golfers.map((name) => {
        const s = scores[name];
        if (!s || !name) return { name, score: null, missedCut: false, position: "-" };
        hasScores = true;
        
const effectiveScore = s.missedCut
  ? (s.score || 0) + 5
  : s.isWinner
    ? (s.score || 0) - 5
    : s.score || 0;

        total += effectiveScore;
        return { name, score: s.score, effectiveScore, missedCut: s.missedCut, isWinner: s.isWinner, position: s.position };
      });
      return { ...pick, golferDetails, total: hasScores ? total : null };
    })
    .sort((a, b) => {
      if (a.total === null && b.total === null) return 0;
      if (a.total === null) return 1;
      if (b.total === null) return -1;
      return a.total - b.total;
    });

  // ── Edit handlers ──
  const startEdit = (pick) => {
    setEditingPick(pick.id);
    setEditForm({ name: pick.name, golfers: [...pick.golfers] });
    setView("manage");
  };

  const medals = ["🥇", "🥈", "🥉"];
  const r = 10, circ = 2 * Math.PI * r;
  const dash = circ * (countdown / AUTO_REFRESH_SEC);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Source+Sans+3:wght@300;400;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --green-deep: #1a3a2a; --green-mid: #2d5a3d; --green-light: #4a8c5c;
          --gold: #c9a84c; --gold-light: #e8c97a;
          --cream: #faf7f0; --warm-white: #fff8ee;
          --text-dark: #1a1a1a; --red: #c0392b;
        }
        body { background: var(--cream); font-family: 'Source Sans 3', sans-serif; color: var(--text-dark); }
        .app { min-height: 100vh; display: flex; flex-direction: column; }

        .header { background: var(--green-deep); position: relative; overflow: hidden; }
        .header::before { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(45deg, transparent, transparent 40px, rgba(255,255,255,0.015) 40px, rgba(255,255,255,0.015) 80px); }
        .header-inner { position: relative; padding: 28px 24px 20px; text-align: center; }
        .header-flag { font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-bottom: 8px; font-weight: 600; }
        .header h1 { font-family: 'Playfair Display', serif; font-size: clamp(26px, 6vw, 42px); font-weight: 900; color: var(--warm-white); line-height: 1.1; }
        .header h1 span { color: var(--gold); }
        .header-sub { font-size: 13px; color: rgba(255,255,255,0.55); margin-top: 6px; letter-spacing: 0.05em; }
        .header-divider { width: 60px; height: 2px; background: linear-gradient(90deg, transparent, var(--gold), transparent); margin: 14px auto 0; }

        .nav { background: var(--green-mid); display: flex; justify-content: center; gap: 2px; padding: 0 16px; border-bottom: 2px solid var(--gold); }
        .nav button { background: none; border: none; cursor: pointer; padding: 12px 20px; font-family: 'Source Sans 3', sans-serif; font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.6); transition: color 0.2s; position: relative; }
        .nav button.active { color: var(--gold); }
        .nav button.active::after { content: ''; position: absolute; bottom: 0; left: 12px; right: 12px; height: 2px; background: var(--gold); }
        .nav button:hover:not(.active) { color: rgba(255,255,255,0.9); }

        .main { flex: 1; padding: 20px 16px 40px; max-width: 760px; margin: 0 auto; width: 100%; }

        .refresh-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; flex-wrap: wrap; gap: 8px; }
        .refresh-left { display: flex; align-items: center; gap: 10px; }
        .last-updated { font-size: 12px; color: #888; font-style: italic; }
        .countdown-wrap { display: flex; align-items: center; gap: 5px; cursor: default; }
        .countdown-wrap svg { transform: rotate(-90deg); }
        .ring-bg { fill: none; stroke: rgba(0,0,0,0.1); stroke-width: 2.5; }
        .ring-fill { fill: none; stroke: var(--green-light); stroke-width: 2.5; stroke-linecap: round; transition: stroke-dasharray 1s linear; }
        .countdown-num { font-size: 11px; color: #aaa; min-width: 22px; }
        .btn-refresh { background: var(--green-deep); color: var(--gold); border: 1px solid var(--gold); border-radius: 6px; padding: 7px 16px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s; letter-spacing: 0.04em; font-family: 'Source Sans 3', sans-serif; }
        .btn-refresh:hover { background: var(--gold); color: var(--green-deep); }
        .btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
        .spin { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error-bar { background: #fee; border: 1px solid #fcc; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: var(--red); margin-bottom: 14px; }
        .db-error { background: #fee; border: 1px solid #fcc; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: var(--red); margin-bottom: 14px; }

        .summary-table { background: var(--green-deep); border-radius: 12px; overflow: hidden; margin-bottom: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.12); }
        .summary-title { font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold); opacity: 0.8; padding: 10px 16px 6px; }
        .summary-row { display: grid; grid-template-columns: 36px 1fr auto auto; align-items: center; padding: 10px 16px; gap: 10px; border-top: 1px solid rgba(255,255,255,0.07); transition: background 0.15s; }
        .summary-row:hover { background: rgba(255,255,255,0.04); }
        .summary-row.leader { background: rgba(201,168,76,0.1); }
        .summary-rank { font-family: 'Playfair Display', serif; font-size: 18px; text-align: center; line-height: 1; }
        .summary-name-bar { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .summary-name { font-size: 14px; font-weight: 600; color: var(--warm-white); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .summary-bar-track { height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; }
        .summary-bar-fill { height: 100%; border-radius: 2px; transition: width 0.6s ease; }
        .summary-gap { font-size: 11px; color: rgba(255,255,255,0.4); text-align: right; white-space: nowrap; }
        .summary-score { font-family: 'Playfair Display', serif; font-size: 18px; font-weight: 700; min-width: 42px; text-align: right; }
        .summary-score.score-under { color: var(--gold-light); }
        .summary-score.score-over  { color: #ff8888; }
        .summary-score.score-even  { color: rgba(255,255,255,0.6); }
        .summary-score.score-neutral { color: rgba(255,255,255,0.3); font-size: 14px; }

        .leaderboard { display: flex; flex-direction: column; gap: 12px; }
        .friend-card { background: var(--warm-white); border-radius: 12px; border: 1px solid #e8e0d0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05); transition: transform 0.15s, box-shadow 0.15s; animation: fadeSlide 0.4s ease both; }
        .friend-card:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.09); }
        @keyframes fadeSlide { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .friend-card.rank-1 { border-color: var(--gold); box-shadow: 0 2px 16px rgba(201,168,76,0.2); }
        .friend-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: var(--green-deep); cursor: pointer; user-select: none; }
        .friend-header:hover { background: #1f4733; }
        .friend-rank-name { display: flex; align-items: center; gap: 10px; }
        .rank-badge { font-size: 20px; line-height: 1; min-width: 28px; }
        .friend-name { font-family: 'Playfair Display', serif; font-size: 18px; font-weight: 700; color: var(--warm-white); }
        .friend-total { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 900; }
        .friend-total.score-under { color: var(--gold-light); }
        .friend-total.score-over  { color: #ff9999; }
        .friend-total.score-even  { color: rgba(255,255,255,0.7); }
        .friend-total.score-neutral { color: rgba(255,255,255,0.4); font-size: 16px; }
        .chevron { font-size: 11px; color: rgba(255,255,255,0.4); margin-left: 10px; transition: transform 0.25s; display: inline-block; }
        .chevron.open { transform: rotate(180deg); }
        .golfer-grid { display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; max-height: 0; transition: max-height 0.35s ease; }
        .golfer-grid.expanded { max-height: 600px; }
        .golfer-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; border-bottom: 1px solid #f0e8d8; border-right: 1px solid #f0e8d8; gap: 8px; }
        .golfer-row:nth-child(2n) { border-right: none; }
        .golfer-row:nth-last-child(-n+2) { border-bottom: none; }
        .golfer-name-pos { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .golfer-name { font-size: 13px; font-weight: 600; color: var(--text-dark); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .golfer-pos { font-size: 10px; color: #999; letter-spacing: 0.04em; }
        .golfer-score { font-family: 'Playfair Display', serif; font-size: 15px; font-weight: 700; min-width: 32px; text-align: right; flex-shrink: 0; }
        .score-under { color: #1a7a3a; } .score-over { color: var(--red); } .score-even { color: #555; } .score-neutral { color: #bbb; }
        .mc-badge { font-size: 9px; font-weight: 700; background: var(--red); color: white; border-radius: 3px; padding: 1px 5px; margin-left: 4px; vertical-align: middle; }
        .penalty-note { font-size: 10px; color: var(--red); display: block; text-align: right; }

        .rounds-section { padding: 10px 18px 14px; background: #f9f5ec; border-top: 1px solid #ede5d4; grid-column: 1 / -1; }
        .rounds-header { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #999; margin-bottom: 8px; }
        .rounds-table { width: 100%; border-collapse: collapse; }
        .rounds-table th { font-size: 10px; font-weight: 700; color: #aaa; text-align: center; padding: 3px 6px; letter-spacing: 0.06em; }
        .rounds-table th:first-child { text-align: left; }
        .rounds-table td { font-size: 13px; font-weight: 600; text-align: center; padding: 5px 6px; border-top: 1px solid #ede5d4; }
        .rounds-table td:first-child { text-align: left; font-size: 12px; color: #555; font-weight: 400; }
        .round-under { color: #1a7a3a; } .round-over { color: var(--red); } .round-even { color: #555; } .round-na { color: #ccc; font-size: 11px; font-weight: 400; }

        .picks-grid { display: flex; flex-direction: column; gap: 16px; }
        .pick-card { background: var(--warm-white); border-radius: 10px; border: 1px solid #e8e0d0; padding: 16px 18px; }
        .pick-card h3 { font-family: 'Playfair Display', serif; font-size: 17px; font-weight: 700; color: var(--green-deep); margin-bottom: 10px; border-bottom: 1px solid #e8e0d0; padding-bottom: 8px; }
        .pick-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
        .pick-list li { font-size: 14px; padding: 4px 0; display: flex; align-items: center; gap: 8px; }
        .pick-num { color: var(--gold); font-weight: 700; font-size: 12px; min-width: 18px; }

        .manage-section { display: flex; flex-direction: column; gap: 16px; }
        .manage-note { background: #e8f5ee; border: 1px solid #b2dfca; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: var(--green-mid); line-height: 1.5; }
        .manage-card { background: var(--warm-white); border-radius: 10px; border: 1px solid #e8e0d0; padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .manage-card-name { font-weight: 700; font-size: 15px; color: var(--text-dark); }
        .manage-card-golfers { font-size: 12px; color: #777; margin-top: 2px; }
        .manage-actions { display: flex; gap: 8px; flex-shrink: 0; }
        .btn-sm { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid transparent; font-family: 'Source Sans 3', sans-serif; }
        .btn-edit { background: var(--green-deep); color: var(--gold); }
        .btn-edit:hover { background: var(--green-mid); }
        .btn-delete { background: white; color: var(--red); border-color: #fcc; }
        .btn-delete:hover { background: #fee; }
        .btn-add { background: var(--gold); color: var(--green-deep); border: none; border-radius: 8px; padding: 11px 20px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: 'Source Sans 3', sans-serif; transition: background 0.2s; margin-top: 4px; }
        .btn-add:hover { background: var(--gold-light); }

        .pw-gate { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 24px; gap: 16px; }
        .pw-gate-icon { font-size: 36px; margin-bottom: 4px; }
        .pw-gate h3 { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 700; color: var(--green-deep); }
        .pw-gate p { font-size: 13px; color: #888; text-align: center; }
        .pw-row { display: flex; gap: 10px; width: 100%; max-width: 320px; }
        .pw-input { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: 'Source Sans 3', sans-serif; color: #1a1a1a; background: white; transition: border-color 0.2s; }
        .pw-input:focus { outline: none; border-color: var(--green-light); }
        .pw-input.error { border-color: var(--red); animation: shake 0.3s ease; }
        @keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
        .pw-btn { background: var(--green-deep); color: var(--gold); border: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: 'Source Sans 3', sans-serif; transition: background 0.2s; white-space: nowrap; }
        .pw-btn:hover { background: var(--green-mid); }
        .pw-error { font-size: 12px; color: var(--red); margin-top: -8px; }

        .edit-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
        .edit-modal { background: var(--warm-white); border-radius: 14px; padding: 24px; width: 100%; max-width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        .edit-modal h3 { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 700; color: var(--green-deep); margin-bottom: 18px; }
        .form-group { margin-bottom: 14px; }
        .form-label { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; color: #666; text-transform: uppercase; display: block; margin-bottom: 5px; }
        .form-input { width: 100%; padding: 9px 12px; border: 1px solid #ddd; border-radius: 7px; font-size: 14px; font-family: 'Source Sans 3', sans-serif; background: white; color: #1a1a1a; }
        .form-input:focus { outline: none; border-color: var(--green-light); }
        .form-actions { display: flex; gap: 10px; margin-top: 20px; }
        .btn-save { flex: 1; background: var(--green-deep); color: var(--gold); border: none; border-radius: 8px; padding: 11px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: 'Source Sans 3', sans-serif; }
        .btn-save:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-cancel { flex: 1; background: white; color: #666; border: 1px solid #ddd; border-radius: 8px; padding: 11px; font-size: 14px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; }

        .loading-state { text-align: center; padding: 40px; color: #aaa; }
        .empty-state { text-align: center; padding: 40px; color: #aaa; font-style: italic; }
        .footer { text-align: center; padding: 16px; font-size: 11px; color: #aaa; letter-spacing: 0.05em; border-top: 1px solid #e8e0d0; }

        @media (max-width: 480px) {
          .golfer-grid { grid-template-columns: 1fr; }
          .golfer-row { border-right: none !important; }
          .golfer-row:nth-last-child(-n+2) { border-bottom: 1px solid #f0e8d8; }
          .golfer-row:last-child { border-bottom: none; }
        }
      `}</style>

      <div className="app">
        <header className="header">
          <div className="header-inner">
            <div className="header-flag">⛳ Augusta National · 2026</div>
            <h1>The <span>Masters</span><br />Pick'em</h1>
            <p className="header-sub">4 picks · Under par scores · +5 for missed cuts</p>
            <div className="header-divider" />
          </div>
        </header>

        <nav className="nav">
          {[["leaderboard", "🏆 Leaderboard"], ["picks", "📋 All Picks"], ["manage", "⚙️ Manage"]].map(([v, label]) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{label}</button>
          ))}
        </nav>

        <main className="main">

          {/* ── LEADERBOARD ── */}
          {view === "leaderboard" && (
            <>
              <div className="refresh-bar">
                <div className="refresh-left">
                  <div className="countdown-wrap" title={"Auto-refresh in " + countdown + "s"}>
                    <svg width="26" height="26" viewBox="0 0 26 26">
                      <circle className="ring-bg" cx="13" cy="13" r={r} />
                      <circle className="ring-fill" cx="13" cy="13" r={r} strokeDasharray={dash + " " + circ} />
                    </svg>
                    <span className="countdown-num">{countdown}s</span>
                  </div>
                  <div className="last-updated">
                    {lastUpdated ? "Updated " + lastUpdated.toLocaleTimeString() : loading ? "Fetching scores…" : "Loading…"}
                  </div>
                </div>
                <button className="btn-refresh" onClick={() => refreshScores(false)} disabled={loading}>
                  {loading ? <span className="spin">↻</span> : "↻"} {loading ? "Fetching…" : "Refresh Now"}
                </button>
              </div>

              {error && <div className="error-bar">⚠️ {error}</div>}

              {picksLoading && (
                <div className="loading-state"><span className="spin">↻</span> Loading picks…</div>
              )}

              {!picksLoading && scoresLoaded && friendTotals.length > 0 && (() => {
                const valid = friendTotals.filter(f => f.total !== null);
                const leader = valid.length ? valid[0].total : 0;
                const worst  = valid.length ? valid[valid.length - 1].total : 0;
                const spread = worst - leader || 1;
                return (
                  <div className="summary-table">
                    <div className="summary-title">Friends Leaderboard</div>
                    {friendTotals.map((friend, i) => {
                      const barW = friend.total !== null ? Math.max(8, 100 - ((friend.total - leader) / spread) * 92) : 0;
                      const barC = friend.total < 0 ? "#c9a84c" : friend.total > 0 ? "#c0392b" : "#888";
                      const gap  = i === 0 && friend.total !== null ? "Leader"
                                 : friend.total !== null ? "+" + (friend.total - leader) : "";
                      return (
                        <div key={friend.id} className={"summary-row" + (i === 0 ? " leader" : "")}>
                          <div className="summary-rank">{medals[i] || (i + 1)}</div>
                          <div className="summary-name-bar">
                            <span className="summary-name">{friend.name}</span>
                            <div className="summary-bar-track">
                              <div className="summary-bar-fill" style={{ width: barW + "%", background: barC }} />
                            </div>
                          </div>
                          <div className="summary-gap">{gap}</div>
                          <div className={"summary-score " + (friend.total !== null ? scoreClass(friend.total) : "score-neutral")}>
                            {friend.total !== null ? scoreDisplay(friend.total) : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <div className="leaderboard">
                {friendTotals.map((friend, i) => {
                  const isOpen = expandedId === friend.id;
                  return (
                    <div key={friend.id} className={"friend-card" + (i === 0 ? " rank-1" : "")}>
                      <div className="friend-header" onClick={() => setExpandedId(isOpen ? null : friend.id)}>
                        <div className="friend-rank-name">
                          <div className="rank-badge">{medals[i] || "#" + (i + 1)}</div>
                          <div className="friend-name">{friend.name}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center" }}>
                          <div className={"friend-total " + (friend.total !== null ? scoreClass(friend.total) : "score-neutral")}>
                            {friend.total !== null ? scoreDisplay(friend.total) : "—"}
                          </div>
                          <span className={"chevron" + (isOpen ? " open" : "")}>▼</span>
                        </div>
                      </div>
                      <div className={"golfer-grid" + (isOpen ? " expanded" : "")}>
                        {friend.golferDetails.map((g) => (
                          <div key={g.name} className="golfer-row">
                            <div className="golfer-name-pos">
                              <span className="golfer-name">
                                {g.name}
                                {g.missedCut && <span className="mc-badge">MC</span>}
{g.isWinner && <span className="win-badge">🏆 W</span>}
                              </span>
                              <span className="golfer-pos">{g.position !== "-" ? g.position : ""}</span>
                            </div>
                            <div>
                              <div className={"golfer-score " + (g.score !== null ? scoreClass(g.score) : "score-neutral")}>
                                {g.score !== null ? scoreDisplay(g.score) : "—"}
                              </div>
                              {g.missedCut && <span className="penalty-note">+5 pen.</span>}
{g.isWinner && <span className="winner-note">-5 bonus</span>}
                            </div>
                          </div>
                        ))}
                        {isOpen && (
                          <div className="rounds-section">
                            <div className="rounds-header">Round by Round</div>
                            <table className="rounds-table">
                              <thead>
                                <tr>
                                  <th>Player</th>
                                  <th>R1</th><th>R2</th><th>R3</th><th>R4</th>
                                </tr>
                              </thead>
                              <tbody>
                                {friend.golferDetails.map((g) => {
                                  const rounds = scores[g.name]?.rounds ?? [null, null, null, null];
                                  const mc = g.missedCut;
                                  return (
                                    <tr key={g.name}>
                                      <td>{g.name.split(" ").pop()}</td>
                                      {rounds.map((round, ri) => {
                                        if (mc && ri >= 2) return <td key={ri} className="round-na">N/A</td>;
                                        if (round === null) return <td key={ri} className="round-na">—</td>;
                                        const cls = round < 0 ? "round-under" : round > 0 ? "round-over" : "round-even";
                                        return <td key={ri} className={cls}>{scoreDisplay(round)}</td>;
                                      })}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── PICKS VIEW ── */}
          {view === "picks" && (
            <div className="picks-grid">
              {picksLoading
                ? <div className="loading-state"><span className="spin">↻</span></div>
                : picks.map((pick) => (
                  <div key={pick.id} className="pick-card">
                    <h3>{pick.name}</h3>
                    <ul className="pick-list">
                      {pick.golfers.map((g, i) => (
                        <li key={i}>
                          <span className="pick-num">{i + 1}.</span>
                          {g || <em style={{ color: "#bbb" }}>Empty</em>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              }
            </div>
          )}

          {/* ── MANAGE VIEW ── */}
          {view === "manage" && !editingPick && (
            !manageUnlocked ? (
              <div className="pw-gate">
                <div className="pw-gate-icon">🔒</div>
                <h3>Admin Access</h3>
                <p>Enter the password to add or edit picks.</p>
                <div className="pw-row">
                  <input
                    className={"pw-input" + (pwError ? " error" : "")}
                    type="password"
                    placeholder="Password"
                    value={pwInput}
                    onChange={(e) => { setPwInput(e.target.value); setPwError(false); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (pwInput === MANAGE_PASSWORD) { setManageUnlocked(true); setPwError(false); }
                        else { setPwError(true); setPwInput(""); }
                      }
                    }}
                  />
                  <button className="pw-btn" onClick={() => {
                    if (pwInput === MANAGE_PASSWORD) { setManageUnlocked(true); setPwError(false); }
                    else { setPwError(true); setPwInput(""); }
                  }}>Unlock</button>
                </div>
                {pwError && <div className="pw-error">Incorrect password — try again.</div>}
              </div>
            ) : (
              <div className="manage-section">
                <div className="manage-note">
                  ✏️ Changes are shared with everyone instantly. Missed cut players receive an automatic <strong>+5 penalty</strong>.
                  <span style={{ float: "right", cursor: "pointer", color: "#aaa", fontSize: 12 }}
                    onClick={() => { setManageUnlocked(false); setPwInput(""); }}>🔒 Lock</span>
                </div>
                {dbError && <div className="db-error">⚠️ {dbError}</div>}
                {picksLoading
                  ? <div className="loading-state"><span className="spin">↻</span> Loading…</div>
                  : picks.map((pick) => (
                    <div key={pick.id} className="manage-card">
                      <div>
                        <div className="manage-card-name">{pick.name}</div>
                        <div className="manage-card-golfers">{pick.golfers.filter(Boolean).join(" · ")}</div>
                      </div>
                      <div className="manage-actions">
                        <button className="btn-sm btn-edit" onClick={() => startEdit(pick)}>Edit</button>
                        <button className="btn-sm btn-delete" onClick={() => deletePick(pick.id)}>✕</button>
                      </div>
                    </div>
                  ))
                }
                <button className="btn-add" onClick={() => { setEditingPick("new"); setEditForm({ name: "", golfers: ["", "", "", ""] }); }}>
                  + Add Friend
                </button>
              </div>
            )
          )}
        </main>

        {/* ── EDIT MODAL ── */}
        {editingPick && (
          <div className="edit-overlay" onClick={(e) => e.target === e.currentTarget && setEditingPick(null)}>
            <div className="edit-modal">
              <h3>{editingPick === "new" ? "Add Friend" : "Edit Picks"}</h3>
              {dbError && <div className="db-error" style={{ marginBottom: 14 }}>⚠️ {dbError}</div>}
              <div className="form-group">
                <label className="form-label">Friend's Name</label>
                <input className="form-input" value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  placeholder="e.g. Paddy" />
              </div>
              {[0, 1, 2, 3].map((i) => (
                <div className="form-group" key={i}>
                  <label className="form-label">Pick {i + 1}</label>
                  <input className="form-input" value={editForm.golfers[i]}
                    onChange={(e) => {
                      const g = [...editForm.golfers];
                      g[i] = e.target.value;
                      setEditForm({ ...editForm, golfers: g });
                    }}
                    placeholder="e.g. Rory McIlroy" />
                </div>
              ))}
              <div className="form-actions">
                <button className="btn-cancel" onClick={() => { setEditingPick(null); setDbError(null); }}>Cancel</button>
                <button className="btn-save" onClick={savePick} disabled={saving}>
                  {saving ? "Saving…" : "Save Picks"}
                </button>
              </div>
            </div>
          </div>
        )}

        <footer className="footer">
          THE MASTERS · AUGUSTA NATIONAL · PAR 72 · LIVE VIA ESPN and RG· AUTO-REFRESH 60s
        </footer>
      </div>
    </>
  );
}