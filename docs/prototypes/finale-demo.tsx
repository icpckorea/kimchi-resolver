/** Development-only preview using the production AwardView and real award store. */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppStore, type AppStore } from '../../src/store/appStore';
import { AwardView } from '../../src/ui/award/AwardView';
import type { FinaleType } from '../../src/ui/award/mahjongFinale';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const letters = [...'ABCDEFGHIJKLM'];
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function FinaleDemo() {
  const [type, setType] = useState<FinaleType>(params.get('finaleType') === 'gacha-ssr' ? 'gacha-ssr' : 'mahjong-soul-like');
  const [problem, setProblem] = useState(letters.includes(params.get('problem') ?? '') ? params.get('problem')! : 'H');
  const [accepted, setAccepted] = useState(params.get('verdict') !== 'No');
  const [magnify, setMagnify] = useState(params.get('magnify') === 'true');
  const [store, setStore] = useState<AppStore | null>(null);
  const [seq, setSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  async function prepare(play = false) {
    const request = ++requestRef.current;
    setLoading(true);
    const finalIndex = letters.indexOf(problem);
    const config = {
      source: { type: 'spotboard', apiBase: '/finale-sample/' }, apac: { enabled: false }, magnify,
      award: { finaleType: type, awardsUrl: '', focusBlinking: null, hideName: false,
        animationSpeeds: [{ minSolved: 0, fastFlip: 120, slowFlip: 400, moveUpMsPerRow: 100 }] },
    };
    const contest = { title: 'Finale Sample', systemName: 'sample', systemVersion: '1',
      problems: letters.map((name, id) => ({ id, name, title: `Problem ${name}`, color: '#60944d' })),
      teams: [{ id: 1, name: 'Team Kimchi', group: 'Sample University' }],
    };
    const runs = { time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 }, runs: [
      ...letters.map((_, i) => ({ id: i + 1, team: 1, problem: i, result: i === finalIndex ? 'No - Wrong Answer' : 'Yes', submissionTime: 20 + i })),
      { id: 14, team: 1, problem: finalIndex, result: accepted ? 'Yes' : 'No - Wrong Answer', submissionTime: 299 },
    ] };
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    const next = createAppStore({
      scheduler: { setInterval: () => 0, clearInterval: () => {} }, rng: () => .99,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('config.json')) return json(config);
        if (url.includes('contest.json')) return json(contest);
        if (url.includes('runs.json')) return json(runs);
        if (url.includes('orgs.json')) return json([]);
        return new Response('', { status: 404 });
      },
    });
    await next.getState().boot('?award=true&r=13');
    if (request !== requestRef.current) return;
    next.getState().awardAdvance(); // focus the sole sample team
    setStore(next);
    setSeq((n) => n + 1);
    setLoading(false);
    if (play) {
      await nextFrame(); await nextFrame();
      if (request === requestRef.current) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    }
  }
  useEffect(() => { void prepare(); }, []);
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 16, fontFamily: 'system-ui' }}>
      <strong>Finale preview</strong>
      <select aria-label="Finale type" value={type} onChange={(e) => setType(e.target.value as FinaleType)}>
        <option value="mahjong-soul-like">Mahjong soul like</option><option value="gacha-ssr">Gacha SSR</option>
      </select>
      <select aria-label="Final problem" value={problem} onChange={(e) => setProblem(e.target.value)}>{letters.map((l) => <option key={l}>{l}</option>)}</select>
      <select aria-label="Verdict" value={accepted ? 'Yes' : 'No'} onChange={(e) => setAccepted(e.target.value === 'Yes')}><option>Yes</option><option>No</option></select>
      <label><input type="checkbox" checked={magnify} onChange={(e) => setMagnify(e.target.checked)} /> Magnify</label>
      <button disabled={loading || store === null} onClick={() => void prepare(true)}>Play finale</button>
      <span>Sample data · production renderer</span>
    </div>
    <div className="app-main--award" style={{ padding: 16 }}>
      {store ? <AwardView key={seq} store={store} /> : 'Loading…'}
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><FinaleDemo /></StrictMode>);
