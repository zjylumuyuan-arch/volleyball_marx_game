import React, { Suspense, useEffect, useMemo, useState } from "react";
import { HOST_PIN, isSupabaseConfigured, supabase } from "./supabaseClient.js";
import {
  gameData,
  OPTION_KEYS,
  getPrimaryBranch,
  getRoundScene,
  getRouteDetails
} from "./gameData.js";

const GAME_ID = "main";
const QRCodeSVG = React.lazy(() =>
  import("qrcode.react").then((module) => ({ default: module.QRCodeSVG }))
);

const emptyVotes = OPTION_KEYS.reduce((acc, key) => {
  acc[key] = 0;
  return acc;
}, {});

const defaultGameState = {
  id: GAME_ID,
  phase: "cover",
  round_index: -1,
  round_id: null,
  route: [],
  voting_open: false,
  voting_locked: false,
  leader: null,
  message: "等待主持人开始。"
};

function normalizeState(row) {
  return {
    ...defaultGameState,
    ...row,
    route: Array.isArray(row?.route) ? row.route : []
  };
}

function makeRoundId(index) {
  return `round-${index}-${Date.now()}`;
}

function getRoundByState(state) {
  return gameData.rounds[state.round_index] || null;
}

function getTotalVotes(votes) {
  return OPTION_KEYS.reduce((sum, key) => sum + (votes?.[key] || 0), 0);
}

function getLeadingChoice(votes) {
  let max = -1;
  let winner = "A";
  for (const key of OPTION_KEYS) {
    const count = votes?.[key] || 0;
    if (count > max) {
      max = count;
      winner = key;
    }
  }
  return winner;
}

function countVotes(rows) {
  return rows.reduce(
    (acc, row) => {
      if (OPTION_KEYS.includes(row.choice)) {
        acc[row.choice] += 1;
      }
      return acc;
    },
    { ...emptyVotes }
  );
}

function getVoteUrl() {
  const override = String(import.meta.env.VITE_VOTE_URL_OVERRIDE || "").trim();
  if (override) return override;
  return `${window.location.origin}/vote`;
}

function getOrCreateVoterId() {
  const key = "volleyball-marx-voter-id";
  let voterId = window.localStorage.getItem(key);
  if (!voterId) {
    voterId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    window.localStorage.setItem(key, voterId);
  }
  return voterId;
}

async function saveGameState(patch) {
  if (!supabase) return { error: new Error("Supabase is not configured.") };
  return supabase
    .from("game_state")
    .upsert(
      {
        id: GAME_ID,
        ...patch,
        updated_at: new Date().toISOString()
      },
      { onConflict: "id" }
    )
    .select()
    .single();
}

async function deleteAllVotes() {
  if (!supabase) return { error: new Error("Supabase is not configured.") };
  return supabase.from("votes").delete().neq("round_id", "__never__");
}

function useGameState() {
  const [state, setState] = useState(defaultGameState);
  const [connection, setConnection] = useState(
    isSupabaseConfigured ? "connecting" : "missing-env"
  );
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;

    async function loadState() {
      const { data, error: selectError } = await supabase
        .from("game_state")
        .select("*")
        .eq("id", GAME_ID)
        .maybeSingle();

      if (cancelled) return;

      if (selectError) {
        setError(selectError.message);
        setConnection("error");
        return;
      }

      if (data) {
        setState(normalizeState(data));
        return;
      }

      const { data: inserted, error: insertError } = await saveGameState(defaultGameState);
      if (cancelled) return;

      if (insertError) {
        setError(insertError.message);
        setConnection("error");
      } else {
        setState(normalizeState(inserted));
      }
    }

    loadState();

    const channel = supabase
      .channel("game-state-screen")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_state", filter: `id=eq.${GAME_ID}` },
        (payload) => {
          if (payload.new) setState(normalizeState(payload.new));
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setConnection("connected");
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConnection("error");
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return { state, connection, error };
}

function useRoundVotes(roundId) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase || !roundId) {
      setRows([]);
      return;
    }

    let cancelled = false;

    async function loadVotes() {
      const { data, error: selectError } = await supabase
        .from("votes")
        .select("round_id, round_index, voter_id, choice, created_at")
        .eq("round_id", roundId);

      if (cancelled) return;

      if (selectError) {
        setError(selectError.message);
      } else {
        setRows(data || []);
      }
    }

    loadVotes();

    const channel = supabase
      .channel(`votes-${roundId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "votes", filter: `round_id=eq.${roundId}` },
        loadVotes
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [roundId]);

  return { rows, votes: useMemo(() => countVotes(rows), [rows]), error };
}

function PhaseText({ phase }) {
  const textMap = {
    cover: "等待开始",
    briefing: "剧情导入",
    voting: "投票中",
    locked: "结果锁定",
    final: "最终总结"
  };

  return <span className={`phase phase-${phase}`}>{textMap[phase] || phase}</span>;
}

function Header({ state, connection }) {
  return (
    <header className="app-header">
      <div>
        <div className="eyebrow">{gameData.shortTitle}</div>
        <h1>{gameData.title}</h1>
        <p>{gameData.subtitle}</p>
      </div>
      <div className="header-status">
        <div className="mini-qr">
          <Suspense fallback={<div className="qr-loading" />}>
            <QRCodeSVG value={getVoteUrl()} size={108} level="H" includeMargin />
          </Suspense>
          <span>扫码投票</span>
        </div>
        <div className="status-stack">
          <PhaseText phase={state.phase} />
          <span className={`connection ${connection}`}>
            {connection === "connected" ? "已连接" : connection === "missing-env" ? "待配置" : "连接中"}
          </span>
        </div>
      </div>
    </header>
  );
}

function SetupNotice({ error }) {
  return (
    <main className="phone-shell">
      <section className="phone-card setup-card">
        <h1>Supabase 尚未配置</h1>
        <p>请在本地 `.env.local` 或 Vercel 环境变量中配置：</p>
        <pre>VITE_SUPABASE_URL{"\n"}VITE_SUPABASE_ANON_KEY{"\n"}VITE_HOST_PIN</pre>
        {error && <p className="notice">当前错误：{error}</p>}
      </section>
    </main>
  );
}

function CoverScreen({ state }) {
  const voteUrl = getVoteUrl();

  return (
    <main className="cover-grid">
      <section className="hero-card">
        <div className="hero-score">0:2</div>
        <h2>这不是普通投票，是一场“赛点辩论”。</h2>
        <p>
          同学扫码进入手机端，每轮选择 A/B/C/D。大屏实时显示票数，主持人锁定后按最高票推进剧情。
        </p>
        <div className="source-mini">
          女排精神四个关键词，与马克思主义基本原理中的实践、矛盾、意识、集体等概念自然相连。
        </div>
      </section>

      <section className="qr-card">
        <Suspense fallback={<div className="qr-loading large" />}>
          <QRCodeSVG value={voteUrl} size={230} level="H" includeMargin />
        </Suspense>
        <p className="qr-url">{voteUrl}</p>
        <p className="control-hint">主持人在底部控制区输入 PIN 后开始游戏。</p>
        <p className="muted">{state.message}</p>
      </section>
    </main>
  );
}

function OptionBoard({ round, state, votes }) {
  const total = getTotalVotes(votes);
  const leader = state.leader || getLeadingChoice(votes);

  return (
    <div className="option-board">
      {OPTION_KEYS.map((key) => {
        const option = round.options[key];
        const count = votes[key] || 0;
        const pct = total ? Math.round((count / total) * 100) : 0;
        const isLeader = key === leader && total > 0;

        return (
          <article className={`option-card ${isLeader ? "leader" : ""}`} key={key}>
            <div className="option-top">
              <span className="option-key">{key}</span>
              <span className="vote-count">{count} 票</span>
            </div>
            <h3>{option.text}</h3>
            <p>{option.theory}</p>
            <div className="bar-wrap">
              <div className="bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="percent">{pct}%</div>
            {isLeader && <div className="leader-label">当前最高票</div>}
          </article>
        );
      })}
    </div>
  );
}

function OutcomePanel({ round, state, votes }) {
  if (state.phase !== "locked") return null;
  const choice = state.leader || getLeadingChoice(votes);
  const option = round.options[choice];

  return (
    <aside className="outcome-panel">
      <div className="eyebrow">多数路线：{choice}</div>
      <h3>{option.tag}</h3>
      <p>{option.outcome}</p>
    </aside>
  );
}

function RoundScreen({ state, votes }) {
  const round = getRoundByState(state) || gameData.rounds[0];
  const scene = getRoundScene(round, state.route);
  const total = getTotalVotes(votes);
  const leader = total ? state.leader || getLeadingChoice(votes) : "暂无";

  return (
    <main className="round-layout">
      <section className="story-panel">
        <div className="round-badge">{round.badge}</div>
        <h2>{round.title}</h2>
        <p className="scene">{scene}</p>
        <div className="question-box">
          <span>本轮问题</span>
          <strong>{round.question}</strong>
        </div>
        <p className="host-tip">{round.hostTip}</p>
        <OutcomePanel round={round} state={state} votes={votes} />
      </section>

      <section className="score-panel">
        <div className="score-header">
          <div>
            <span className="eyebrow">实时选择</span>
            <h2>A/B/C/D 票数</h2>
          </div>
          <div className="score-side">
            <div className="big-total">{total} 人</div>
            <div className="top-choice">最高票：{leader}</div>
          </div>
        </div>
        <OptionBoard round={round} state={state} votes={votes} />
      </section>
    </main>
  );
}

function FinalScreen({ state }) {
  const primaryBranch = getPrimaryBranch(state.route);
  const final = gameData.finalByBranch[primaryBranch] || gameData.finalByBranch.practice;
  const details = getRouteDetails(state.route);

  return (
    <main className="final-layout">
      <section className="final-card">
        <div className="round-badge">最终路线</div>
        <h2>{final.title}</h2>
        <p className="final-thesis">{final.thesis}</p>
        <div className="marx-link">
          <span>马原回扣</span>
          <strong>{final.marxLink}</strong>
        </div>
        <p className="closing-line">{gameData.closingLine}</p>
      </section>

      <section className="route-card">
        <h3>本班选择链</h3>
        {details.map((item, index) => (
          <div className="route-item" key={`${item.choice}-${index}`}>
            <span>{index + 1}</span>
            <div>
              <strong>
                {item.choice} 路 {item.tag}
              </strong>
              <p>{item.theory}</p>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}

function HostPanel({ state, votes, actions, busy, error }) {
  const [collapsed, setCollapsed] = useState(false);
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(
    window.localStorage.getItem("volleyball-host-unlocked") === "true"
  );
  const [pinError, setPinError] = useState("");

  const canStart = state.phase === "cover" || state.phase === "final";
  const canVote = state.phase === "briefing";
  const canLock = state.phase === "voting";
  const canNext = state.phase === "locked";
  const total = getTotalVotes(votes);
  const leader = total ? state.leader || getLeadingChoice(votes) : "A";

  function unlock(event) {
    event.preventDefault();
    if (pin === HOST_PIN) {
      setUnlocked(true);
      setPinError("");
      window.localStorage.setItem("volleyball-host-unlocked", "true");
    } else {
      setPinError("PIN 不正确");
    }
  }

  return (
    <section className={`host-panel ${collapsed ? "collapsed" : ""}`}>
      <button className="ghost collapse-button" onClick={() => setCollapsed((value) => !value)}>
        {collapsed ? "显示控制" : "隐藏控制"}
      </button>

      {!collapsed && (
        <>
          <div className="host-main">
            <div>
              <div className="eyebrow">主持人控制区（和大屏同页）</div>
              <p>{state.message}</p>
              {error && <p className="host-error">{error}</p>}
            </div>

            {!unlocked ? (
              <form className="pin-form" onSubmit={unlock}>
                <input
                  aria-label="主持人 PIN"
                  inputMode="numeric"
                  placeholder="输入 PIN"
                  type="password"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                />
                <button type="submit">解锁</button>
                {pinError && <span>{pinError}</span>}
              </form>
            ) : (
              <div className="host-buttons">
                <button disabled={!canStart || busy} onClick={actions.startGame}>
                  开始游戏
                </button>
                <button disabled={!canVote || busy} onClick={actions.openVoting}>
                  开放投票
                </button>
                <button disabled={!canLock || busy} onClick={actions.lockVoting}>
                  锁定投票
                </button>
                <button disabled={!canNext || busy} onClick={actions.nextRound}>
                  按最高票推进
                </button>
                <button className="danger" disabled={busy} onClick={actions.resetGame}>
                  重置游戏
                </button>
              </div>
            )}
          </div>

          {unlocked && (
            <div className="host-meta">
              当前最高票：<strong>{leader}</strong>
              <span>总票数：{total}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function VoteView({ state, connection }) {
  const voterId = useMemo(() => getOrCreateVoterId(), []);
  const round = getRoundByState(state);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state.round_id) {
      setSelected(null);
      setNotice("");
      return;
    }
    setSelected(window.localStorage.getItem(`volleyball-choice-${state.round_id}`));
    setNotice("");
  }, [state.round_id]);

  async function submit(choice) {
    if (!supabase || !round) return;
    if (state.phase !== "voting" || !state.voting_open || state.voting_locked) {
      setNotice("主持人还没有开放投票，或本轮投票已锁定。");
      return;
    }

    setBusy(true);
    const { error } = await supabase.from("votes").upsert(
      {
        round_id: state.round_id,
        round_index: state.round_index,
        voter_id: voterId,
        choice
      },
      { onConflict: "round_id,voter_id" }
    );
    setBusy(false);

    if (error) {
      setNotice(`提交失败：${error.message}`);
      return;
    }

    setSelected(choice);
    window.localStorage.setItem(`volleyball-choice-${state.round_id}`, choice);
    setNotice(`已选择 ${choice}，锁定前可以改选。`);
  }

  if (state.phase === "cover" || !round) {
    return (
      <main className="phone-shell">
        <section className="phone-card">
          <h1>{gameData.shortTitle}</h1>
          <p>已进入投票页，请看大屏等待主持人开始。</p>
          <PhaseText phase={state.phase} />
          <span className={`connection ${connection}`}>{connection === "connected" ? "已连接" : "连接中"}</span>
        </section>
      </main>
    );
  }

  if (state.phase === "final") {
    const final = gameData.finalByBranch[getPrimaryBranch(state.route)] || gameData.finalByBranch.practice;
    return (
      <main className="phone-shell">
        <section className="phone-card">
          <div className="round-badge">最终路线</div>
          <h1>{final.title}</h1>
          <p>{final.thesis}</p>
          <p className="muted">请回看大屏的完整总结。</p>
        </section>
      </main>
    );
  }

  const disabled = busy || state.phase !== "voting" || !state.voting_open || state.voting_locked;

  return (
    <main className="phone-shell">
      <section className="phone-card">
        <div className="phone-top">
          <PhaseText phase={state.phase} />
          <span>{round.badge}</span>
        </div>
        <h1>{round.title}</h1>
        <p className="phone-question">{round.question}</p>

        <div className="phone-options">
          {OPTION_KEYS.map((key) => {
            const option = round.options[key];
            return (
              <button
                key={key}
                disabled={disabled}
                className={selected === key ? "selected" : ""}
                onClick={() => submit(key)}
              >
                <span>{key}</span>
                <strong>{option.text}</strong>
                <small>{option.tag}</small>
              </button>
            );
          })}
        </div>

        {state.phase === "locked" && (
          <div className="phone-result">本轮多数选择：{state.leader || "等待统计"}</div>
        )}
        <p className="notice">
          {notice || (state.phase === "voting" ? "请选择一项。" : "请听主持人讲解。")}
        </p>
      </section>
    </main>
  );
}

function ScreenView({ state, connection, votes, actions, busy, error }) {
  return (
    <div className="screen">
      <Header state={state} connection={connection} />
      {state.phase === "cover" && <CoverScreen state={state} />}
      {state.phase !== "cover" && state.phase !== "final" && <RoundScreen state={state} votes={votes} />}
      {state.phase === "final" && <FinalScreen state={state} />}
      <HostPanel state={state} votes={votes} actions={actions} busy={busy} error={error} />
    </div>
  );
}

export default function App() {
  const { state, connection, error: stateError } = useGameState();
  const { votes, error: votesError } = useRoundVotes(state.round_id);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const isVotePage = window.location.pathname.toLowerCase().startsWith("/vote");

  async function runAction(action) {
    setBusy(true);
    setActionError("");
    const { error } = await action();
    setBusy(false);
    if (error) setActionError(error.message);
  }

  const actions = {
    startGame: () =>
      runAction(async () => {
        const deleteResult = await deleteAllVotes();
        if (deleteResult.error) return deleteResult;
        return saveGameState({
          phase: "briefing",
          round_index: 0,
          round_id: makeRoundId(0),
          route: [],
          voting_open: false,
          voting_locked: false,
          leader: null,
          message: "第 1 幕准备中，主持人可开放投票。"
        });
      }),
    openVoting: () =>
      runAction(() =>
        saveGameState({
          phase: "voting",
          voting_open: true,
          voting_locked: false,
          leader: null,
          message: "投票进行中。"
        })
      ),
    lockVoting: () =>
      runAction(() => {
        const leader = getLeadingChoice(votes);
        return saveGameState({
          phase: "locked",
          voting_open: false,
          voting_locked: true,
          leader,
          message: `投票已锁定，最高票为 ${leader}。`
        });
      }),
    nextRound: () =>
      runAction(() => {
        const choice = state.leader || getLeadingChoice(votes);
        const route = [...state.route, choice];
        const nextIndex = state.round_index + 1;

        if (nextIndex >= gameData.rounds.length) {
          return saveGameState({
            phase: "final",
            route,
            voting_open: false,
            voting_locked: true,
            leader: choice,
            message: "路线已完成，生成最终总结。"
          });
        }

        return saveGameState({
          phase: "briefing",
          round_index: nextIndex,
          round_id: makeRoundId(nextIndex),
          route,
          voting_open: false,
          voting_locked: false,
          leader: null,
          message: `第 ${nextIndex + 1} 幕准备中，主持人可开放投票。`
        });
      }),
    resetGame: () =>
      runAction(async () => {
        const deleteResult = await deleteAllVotes();
        if (deleteResult.error) return deleteResult;
        return saveGameState(defaultGameState);
      })
  };

  if (!isSupabaseConfigured) {
    return <SetupNotice error={stateError || votesError || actionError} />;
  }

  if (isVotePage) {
    return <VoteView state={state} connection={connection} />;
  }

  return (
    <ScreenView
      state={state}
      connection={connection}
      votes={votes}
      actions={actions}
      busy={busy}
      error={actionError || stateError || votesError}
    />
  );
}
