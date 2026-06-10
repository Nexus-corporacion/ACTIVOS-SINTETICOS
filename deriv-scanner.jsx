import { useState, useEffect, useRef, useCallback } from "react";

const SYMBOLS = [
  { id: "1HZ50V",  label: "V50 1s",  color: "#00E5FF" },
  { id: "1HZ75V",  label: "V75 1s",  color: "#7C4DFF" },
  { id: "1HZ100V", label: "V100 1s", color: "#FF4081" },
];

const DERIV_WS = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

// ─── Estructura de mercado ────────────────────────────────────────────────────
function detectStructure(candles) {
  if (!candles || candles.length < 10) return null;
  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const n = closes.length;

  // Swing highs / lows (ventana de 3)
  const swingHighs = [], swingLows = [];
  for (let i = 1; i < n - 1; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) swingHighs.push({ i, v: highs[i] });
    if (lows[i]  < lows[i-1]  && lows[i]  < lows[i+1])  swingLows.push({ i, v: lows[i] });
  }

  // Tendencia: comparar últimos 2 swing highs y lows
  let trend = "lateral";
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs[swingHighs.length-1].v > swingHighs[swingHighs.length-2].v;
    const hl = swingLows[swingLows.length-1].v  > swingLows[swingLows.length-2].v;
    const lh = swingHighs[swingHighs.length-1].v < swingHighs[swingHighs.length-2].v;
    const ll = swingLows[swingLows.length-1].v   < swingLows[swingLows.length-2].v;
    if (hh && hl) trend = "alcista";
    else if (lh && ll) trend = "bajista";
  }

  // BOS: cierre por encima del último swing high (alcista) o por debajo del último swing low (bajista)
  const lastClose = closes[n-1];
  const lastSwingHigh = swingHighs.length ? swingHighs[swingHighs.length-1].v : null;
  const lastSwingLow  = swingLows.length  ? swingLows[swingLows.length-1].v   : null;
  let bos = null;
  if (lastSwingHigh && lastClose > lastSwingHigh) bos = "alcista";
  if (lastSwingLow  && lastClose < lastSwingLow)  bos = "bajista";

  // CHoCH: cambio de tendencia reciente
  let choch = null;
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const prevTrend = (() => {
      const hh = swingHighs[swingHighs.length-2]?.v > swingHighs[swingHighs.length-3]?.v;
      const hl = swingLows[swingLows.length-2]?.v   > swingLows[swingLows.length-3]?.v;
      if (hh && hl) return "alcista";
      const lh = swingHighs[swingHighs.length-2]?.v < swingHighs[swingHighs.length-3]?.v;
      const ll = swingLows[swingLows.length-2]?.v   < swingLows[swingLows.length-3]?.v;
      if (lh && ll) return "bajista";
      return "lateral";
    })();
    if (prevTrend !== trend && prevTrend !== "lateral" && trend !== "lateral") choch = trend;
  }

  // Zonas de demanda/oferta (últimos swing lows/highs como zonas)
  const demandZone = swingLows.length  ? swingLows[swingLows.length-1].v   : null;
  const supplyZone = swingHighs.length ? swingHighs[swingHighs.length-1].v : null;

  // Impulso: variación relativa de las últimas 3 velas
  const impulse = n >= 3
    ? Math.abs((closes[n-1] - closes[n-4]) / closes[n-4]) * 100
    : 0;

  // Precio en zona relevante (±0.5% del swing más cercano)
  const nearDemand = demandZone && Math.abs(lastClose - demandZone) / demandZone < 0.005;
  const nearSupply = supplyZone && Math.abs(lastClose - supplyZone) / supplyZone < 0.005;
  const inZone = nearDemand || nearSupply;

  // RSI 14
  let rsi = null;
  if (closes.length >= 16) {
    let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i-1]; if (d > 0) g += d; else l -= d; }
    let ag = g / 14, al = l / 14;
    for (let i = 15; i < closes.length; i++) { const d = closes[i] - closes[i-1]; ag = (ag * 13 + (d > 0 ? d : 0)) / 14; al = (al * 13 + (d < 0 ? -d : 0)) / 14; }
    rsi = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
  }

  return { trend, bos, choch, demandZone, supplyZone, impulse, inZone, lastClose, swingHighs, swingLows, rsi };
}

function score(h1, m15, m5) {
  let pts = 0;
  // H1 estructura (25)
  if (h1?.trend && h1.trend !== "lateral") pts += 25;
  else if (h1?.trend === "lateral") pts += 5;
  // M15 confirmación (20)
  if (m15 && h1 && m15.trend === h1.trend) pts += 20;
  else if (m15 && m15.trend !== "lateral") pts += 8;
  // Zona relevante (25)
  if (h1?.inZone) pts += 25;
  // CHoCH / BOS M5 (20)
  if (m5?.choch) pts += 20;
  else if (m5?.bos) pts += 12;
  // Impulso (10)
  if (m5?.impulse > 0.3) pts += 10;
  else if (m5?.impulse > 0.1) pts += 5;
  return Math.min(pts, 100);
}

function quality(s) {
  if (s >= 80) return { label: "ALTA CALIDAD", color: "#00E676", bg: "rgba(0,230,118,0.1)" };
  if (s >= 60) return { label: "CALIDAD MEDIA", color: "#FFD740", bg: "rgba(255,215,64,0.1)" };
  return { label: "DESCARTAR", color: "#FF5252", bg: "rgba(255,82,82,0.08)" };
}

// ─── Mini sparkline ───────────────────────────────────────────────────────────
function Sparkline({ data, color }) {
  if (!data || data.length < 2) return <div style={{height:48,display:"flex",alignItems:"center",justifyContent:"center",color:"#333",fontSize:11}}>sin datos</div>;
  const vals = data.map(d => parseFloat(d.close));
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const W = 160, H = 48;
  const pts = vals.map((v, i) => `${(i / (vals.length-1)) * W},${H - ((v - min) / range) * (H-4) - 2}`).join(" ");
  const rising = vals[vals.length-1] > vals[0];
  return (
    <svg width={W} height={H} style={{overflow:"visible"}}>
      <defs>
        <linearGradient id={`sg-${color.replace("#","")}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#sg-${color.replace("#","")})`}/>
      <polyline points={pts} fill="none" stroke={rising ? "#00E676" : "#FF5252"} strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx={(vals.length-1)/(vals.length-1)*W} cy={H - ((vals[vals.length-1]-min)/range)*(H-4)-2} r="3" fill={rising?"#00E676":"#FF5252"}/>
    </svg>
  );
}

// ─── Score Ring ───────────────────────────────────────────────────────────────
function ScoreRing({ value }) {
  const r = 28, circ = 2 * Math.PI * r;
  const offset = circ - (value / 100) * circ;
  const q = quality(value);
  return (
    <div style={{position:"relative",width:72,height:72,flexShrink:0}}>
      <svg width={72} height={72}>
        <circle cx={36} cy={36} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={5}/>
        <circle cx={36} cy={36} r={r} fill="none" stroke={q.color} strokeWidth={5}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 36 36)"
          style={{transition:"stroke-dashoffset 1s ease, stroke 0.5s"}}/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
        <span style={{fontSize:18,fontWeight:700,color:q.color,lineHeight:1}}>{value}</span>
        <span style={{fontSize:9,color:"rgba(255,255,255,0.4)",letterSpacing:"0.05em"}}>pts</span>
      </div>
    </div>
  );
}

// ─── Tarjeta de símbolo ───────────────────────────────────────────────────────
function SymbolCard({ sym, data, livePrice }) {
  const h1  = data?.h1  ? detectStructure(data.h1)  : null;
  const m15 = data?.m15 ? detectStructure(data.m15) : null;
  const m5  = data?.m5  ? detectStructure(data.m5)  : null;
  const pts = h1 && m15 && m5 ? score(h1, m15, m5) : 0;
  const q   = quality(pts);
  const loading = !data?.h1;

  const trendIcon = t => t === "alcista" ? "▲" : t === "bajista" ? "▼" : "→";
  const trendCol  = t => t === "alcista" ? "#00E676" : t === "bajista" ? "#FF5252" : "#FFD740";

  return (
    <div style={{
      background:"linear-gradient(135deg,rgba(255,255,255,0.04) 0%,rgba(255,255,255,0.01) 100%)",
      border:`1px solid ${loading?"rgba(255,255,255,0.08)":pts>=80?"rgba(0,230,118,0.25)":pts>=60?"rgba(255,215,64,0.2)":"rgba(255,255,255,0.08)"}`,
      borderRadius:16,padding:"18px 20px",display:"flex",flexDirection:"column",gap:14,
      backdropFilter:"blur(12px)",transition:"border-color 0.5s",
      boxShadow: pts>=80 ? "0 0 24px rgba(0,230,118,0.08)" : pts>=60 ? "0 0 24px rgba(255,215,64,0.06)" : "none"
    }}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:sym.color,boxShadow:`0 0 8px ${sym.color}`}}/>
          <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:17,color:"#fff",letterSpacing:"0.04em"}}>{sym.label}</span>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:15,fontWeight:600,color:"#fff",letterSpacing:"0.02em",fontVariantNumeric:"tabular-nums"}}>
            {livePrice ? parseFloat(livePrice).toFixed(2) : "—"}
          </div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",letterSpacing:"0.06em",marginTop:1}}>PRECIO VIVO</div>
        </div>
      </div>

      {loading ? (
        <div style={{display:"flex",alignItems:"center",gap:8,color:"rgba(255,255,255,0.3)",fontSize:12}}>
          <div style={{width:12,height:12,border:"1.5px solid rgba(255,255,255,0.2)",borderTopColor:sym.color,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
          Cargando datos…
        </div>
      ) : (
        <>
          {/* Sparkline */}
          <Sparkline data={data?.m5?.slice(-40)} color={sym.color}/>

          {/* Score + calidad */}
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <ScoreRing value={pts}/>
            <div style={{flex:1}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",color:q.color,marginBottom:4}}>{q.label}</div>
              <div style={{background:q.bg,borderRadius:6,padding:"4px 8px",display:"inline-block"}}>
                <span style={{fontSize:10,color:q.color,letterSpacing:"0.04em"}}>{pts}/100</span>
              </div>
              <div style={{marginTop:6,fontSize:10,color:"rgba(255,255,255,0.35)"}}>
                {pts>=80 ? "✦ Entrada válida" : pts>=60 ? "◈ Monitorear" : "✕ Sin estructura"}
              </div>
            </div>
            {/* RSI Badge */}
            {m5?.rsi != null && (
              <div style={{
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                background: m5.rsi >= 70 ? "rgba(255,82,82,0.1)" : m5.rsi <= 30 ? "rgba(0,230,118,0.1)" : "rgba(255,215,64,0.08)",
                border: `1px solid ${m5.rsi >= 70 ? "rgba(255,82,82,0.3)" : m5.rsi <= 30 ? "rgba(0,230,118,0.3)" : "rgba(255,215,64,0.2)"}`,
                borderRadius:10,padding:"6px 10px",minWidth:52,
              }}>
                <span style={{fontSize:9,color:"rgba(255,255,255,0.3)",letterSpacing:"0.08em",marginBottom:2}}>RSI</span>
                <span style={{
                  fontSize:18,fontWeight:700,lineHeight:1,
                  fontFamily:"'Space Grotesk',sans-serif",
                  color: m5.rsi >= 70 ? "#FF5252" : m5.rsi <= 30 ? "#00E676" : "#FFD740"
                }}>{m5.rsi}</span>
              </div>
            )}
          </div>

          {/* Estructura por marcos */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
            {[["H1",h1],["M15",m15],["M5",m5]].map(([tf,d])=>(
              <div key={tf} style={{background:"rgba(255,255,255,0.03)",borderRadius:8,padding:"8px 10px",border:"0.5px solid rgba(255,255,255,0.07)"}}>
                <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",letterSpacing:"0.1em",marginBottom:4}}>{tf}</div>
                <div style={{fontSize:12,fontWeight:600,color:d ? trendCol(d.trend) : "#444"}}>
                  {d ? trendIcon(d.trend) : "—"} {d?.trend ?? "—"}
                </div>
                {d?.bos   && <div style={{fontSize:9,color:"#7C4DFF",marginTop:2}}>● BOS {d.bos}</div>}
                {d?.choch && <div style={{fontSize:9,color:"#FF4081",marginTop:2}}>◈ CHoCH</div>}
                {d?.inZone && <div style={{fontSize:9,color:"#00E5FF",marginTop:2}}>⬡ En zona</div>}
              </div>
            ))}
          </div>

          {/* Zonas */}
          {h1 && (
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1,background:"rgba(0,230,118,0.07)",border:"0.5px solid rgba(0,230,118,0.2)",borderRadius:8,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:"rgba(0,230,118,0.6)",letterSpacing:"0.08em",marginBottom:2}}>DEMANDA</div>
                <div style={{fontSize:12,color:"#00E676",fontVariantNumeric:"tabular-nums"}}>{h1.demandZone?.toFixed(2) ?? "—"}</div>
              </div>
              <div style={{flex:1,background:"rgba(255,82,82,0.07)",border:"0.5px solid rgba(255,82,82,0.2)",borderRadius:8,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:"rgba(255,82,82,0.6)",letterSpacing:"0.08em",marginBottom:2}}>OFERTA</div>
                <div style={{fontSize:12,color:"#FF5252",fontVariantNumeric:"tabular-nums"}}>{h1.supplyZone?.toFixed(2) ?? "—"}</div>
              </div>
              <div style={{flex:1,background:"rgba(255,215,64,0.07)",border:"0.5px solid rgba(255,215,64,0.2)",borderRadius:8,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:"rgba(255,215,64,0.6)",letterSpacing:"0.08em",marginBottom:2}}>IMPULSO</div>
                <div style={{fontSize:12,color:"#FFD740",fontVariantNumeric:"tabular-nums"}}>{m5?.impulse?.toFixed(3) ?? "—"}%</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── App principal ────────────────────────────────────────────────────────────
export default function DerivScanner() {
  const [candles, setCandles]     = useState({});    // { symId: { h1, m15, m5 } }
  const [prices,  setPrices]      = useState({});    // { symId: price }
  const [status,  setStatus]      = useState("Conectando…");
  const [lastUpdate, setLastUpdate] = useState(null);
  const [filter, setFilter]       = useState("all"); // all | high | mid
  const wsRef  = useRef(null);
  const queue  = useRef([]);
  const active = useRef(null);
  const reconnectTimer = useRef(null);

  // Cola de requests (1 a la vez para no saturar WS)
  const processQueue = useCallback(() => {
    if (!queue.current.length || active.current) return;
    const req = queue.current.shift();
    active.current = req;
    wsRef.current?.send(JSON.stringify(req));
  }, []);

  const enqueue = useCallback((req) => {
    queue.current.push(req);
    processQueue();
  }, [processQueue]);

  const loadCandles = useCallback((symId, granularity, tfKey) => {
    enqueue({
      ticks_history: symId,
      style: "candles",
      granularity,
      count: 60,
      end: "latest",
      _meta: { symId, tfKey }
    });
  }, [enqueue]);

  const subscribeTicks = useCallback((symId) => {
    enqueue({ ticks: symId, subscribe: 1, _meta: { type: "tick", symId } });
  }, [enqueue]);

  const fetchAll = useCallback(() => {
    setStatus("Actualizando datos…");
    queue.current = [];
    active.current = null;
    SYMBOLS.forEach(s => {
      loadCandles(s.id, 3600, "h1");   // H1
      loadCandles(s.id, 900,  "m15");  // M15
      loadCandles(s.id, 300,  "m5");   // M5
      subscribeTicks(s.id);
    });
  }, [loadCandles, subscribeTicks]);

  const connect = useCallback(() => {
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    const ws = new WebSocket(DERIV_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("Conectado ✦");
      fetchAll();
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.error) { active.current = null; processQueue(); return; }

      // Velas históricas
      if (msg.msg_type === "candles") {
        const req = active.current;
        if (req?._meta) {
          const { symId, tfKey } = req._meta;
          setCandles(prev => ({
            ...prev,
            [symId]: { ...(prev[symId] || {}), [tfKey]: msg.candles }
          }));
        }
        active.current = null;
        setLastUpdate(new Date());
        processQueue();
      }

      // Ticks en vivo
      if (msg.msg_type === "tick") {
        const { symbol, quote } = msg.tick;
        setPrices(prev => ({ ...prev, [symbol]: quote }));
      }

      // Historia de ticks (ya no usamos)
      if (msg.msg_type === "history") {
        active.current = null;
        processQueue();
      }
    };

    ws.onerror = () => setStatus("Error de conexión");
    ws.onclose = () => {
      setStatus("Reconectando…");
      reconnectTimer.current = setTimeout(connect, 4000);
    };
  }, [fetchAll, processQueue]);

  useEffect(() => {
    connect();
    const refreshInterval = setInterval(fetchAll, 60000); // refresh cada 60s
    return () => {
      clearInterval(refreshInterval);
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  // Calcular scores para filtro
  const scored = SYMBOLS.map(s => {
    const d   = candles[s.id];
    const h1  = d?.h1  ? detectStructure(d.h1)  : null;
    const m15 = d?.m15 ? detectStructure(d.m15) : null;
    const m5  = d?.m5  ? detectStructure(d.m5)  : null;
    const pts = h1 && m15 && m5 ? score(h1, m15, m5) : 0;
    return { ...s, pts, h1trend: h1?.trend, rsi: m5?.rsi };
  });

  const filtered = scored.filter(s => {
    if (filter === "high") return s.pts >= 80;
    if (filter === "mid")  return s.pts >= 60 && s.pts < 80;
    if (filter === "trend") return s.h1trend === "alcista" || s.h1trend === "bajista";
    return true;
  });

  const highCount = scored.filter(s => s.pts >= 80).length;
  const midCount  = scored.filter(s => s.pts >= 60 && s.pts < 80).length;

  return (
    <div style={{
      minHeight:"100vh", background:"#080C14",
      fontFamily:"'DM Sans',sans-serif",
      color:"#fff", padding:"24px 20px",
      backgroundImage:"radial-gradient(ellipse 80% 50% at 50% -10%, rgba(124,77,255,0.12), transparent), radial-gradient(ellipse 40% 30% at 80% 60%, rgba(0,229,255,0.06), transparent)"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Space+Grotesk:wght@600;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
        button { cursor: pointer; border: none; outline: none; font-family: inherit; }
      `}</style>

      {/* Header */}
      <div style={{maxWidth:900,margin:"0 auto 28px"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:"#00E676",animation:"pulse 2s ease-in-out infinite",boxShadow:"0 0 8px #00E676"}}/>
              <span style={{fontSize:10,color:"rgba(255,255,255,0.35)",letterSpacing:"0.15em",textTransform:"uppercase"}}>{status}</span>
            </div>
            <h1 style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:26,fontWeight:700,letterSpacing:"-0.02em",lineHeight:1.1,color:"#fff"}}>
              Estructura & PA
              <span style={{color:"rgba(255,255,255,0.25)",fontWeight:400}}> · Escáner</span>
            </h1>
            <p style={{fontSize:12,color:"rgba(255,255,255,0.3)",marginTop:5,letterSpacing:"0.02em"}}>
              V50 · V75 · V100 · 1s — Deriv Synthetic Indices
            </p>
          </div>

          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
            {/* Stats rápidos */}
            <div style={{display:"flex",gap:8}}>
              <div style={{background:"rgba(0,230,118,0.1)",border:"1px solid rgba(0,230,118,0.2)",borderRadius:8,padding:"6px 12px",textAlign:"center"}}>
                <div style={{fontSize:18,fontWeight:700,color:"#00E676"}}>{highCount}</div>
                <div style={{fontSize:9,color:"rgba(0,230,118,0.6)",letterSpacing:"0.08em"}}>ALTA</div>
              </div>
              <div style={{background:"rgba(255,215,64,0.1)",border:"1px solid rgba(255,215,64,0.2)",borderRadius:8,padding:"6px 12px",textAlign:"center"}}>
                <div style={{fontSize:18,fontWeight:700,color:"#FFD740"}}>{midCount}</div>
                <div style={{fontSize:9,color:"rgba(255,215,64,0.6)",letterSpacing:"0.08em"}}>MEDIA</div>
              </div>
              <div style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"6px 12px",textAlign:"center"}}>
                <div style={{fontSize:18,fontWeight:700,color:"rgba(255,255,255,0.5)"}}>{scored.filter(s=>s.pts<60).length}</div>
                <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",letterSpacing:"0.08em"}}>DESCARTE</div>
              </div>
            </div>
            {lastUpdate && (
              <span style={{fontSize:10,color:"rgba(255,255,255,0.2)"}}>
                Actualizado {lastUpdate.toLocaleTimeString("es-ES")}
              </span>
            )}
          </div>
        </div>

        {/* Filtros */}
        <div style={{display:"flex",gap:6,marginTop:16,flexWrap:"wrap"}}>
          {[["all","Todos"],["high","Alta ≥80"],["mid","Media ≥60"],["trend","Tendencia"]].map(([k,l])=>(
            <button key={k} onClick={()=>setFilter(k)} style={{
              padding:"6px 14px",borderRadius:20,fontSize:11,fontWeight:500,letterSpacing:"0.06em",
              background: filter===k ? (k==="trend"?"rgba(0,229,255,0.18)":"rgba(255,255,255,0.12)") : "rgba(255,255,255,0.04)",
              color: filter===k ? (k==="trend"?"#00E5FF":"#fff") : "rgba(255,255,255,0.4)",
              border: `1px solid ${filter===k?(k==="trend"?"rgba(0,229,255,0.35)":"rgba(255,255,255,0.2)"):"rgba(255,255,255,0.06)"}`,
              transition:"all 0.2s"
            }}>{l}</button>
          ))}
          <button onClick={fetchAll} style={{
            padding:"6px 14px",borderRadius:20,fontSize:11,fontWeight:500,letterSpacing:"0.06em",
            background:"rgba(124,77,255,0.15)",color:"rgba(124,77,255,0.9)",
            border:"1px solid rgba(124,77,255,0.3)",transition:"all 0.2s",marginLeft:"auto"
          }}>↺ Actualizar</button>
        </div>
      </div>

      {/* Grid de tarjetas */}
      <div style={{maxWidth:900,margin:"0 auto",display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(270px,1fr))",gap:14}}>
        {filtered.map(sym => (
          <SymbolCard key={sym.id} sym={sym} data={candles[sym.id]} livePrice={prices[sym.id]}/>
        ))}
        {filtered.length === 0 && (
          <div style={{gridColumn:"1/-1",textAlign:"center",padding:"60px 20px",color:"rgba(255,255,255,0.2)",fontSize:13}}>
            No hay señales con ese filtro en este momento.
          </div>
        )}
      </div>

      {/* Leyenda sistema de puntuación */}
      <div style={{maxWidth:900,margin:"28px auto 0",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",borderRadius:12,padding:"16px 20px"}}>
        <div style={{fontSize:10,color:"rgba(255,255,255,0.25)",letterSpacing:"0.12em",marginBottom:12,textTransform:"uppercase"}}>Sistema de puntuación</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:8}}>
          {[
            ["Estructura H1","25 pts","#7C4DFF"],
            ["Confirmación M15","20 pts","#00E5FF"],
            ["Zona relevante","25 pts","#FF4081"],
            ["CHoCH / BOS M5","20 pts","#FFD740"],
            ["Impulso","10 pts","#00E676"],
          ].map(([k,v,c])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:11,color:"rgba(255,255,255,0.35)"}}>{k}</span>
              <span style={{fontSize:11,fontWeight:600,color:c}}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer filosofía */}
      <div style={{maxWidth:900,margin:"16px auto 0",textAlign:"center",padding:"12px 0"}}>
        <p style={{fontSize:10,color:"rgba(255,255,255,0.15)",letterSpacing:"0.08em",lineHeight:1.8}}>
          EL PRECIO MANDA · LA ESTRUCTURA CONFIRMA · LA ACCIÓN DE PRECIO EJECUTA
        </p>
      </div>
    </div>
  );
}
