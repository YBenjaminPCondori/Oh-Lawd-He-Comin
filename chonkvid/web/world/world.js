"use strict";
/*
 * ChonkVid · World Outbreak
 *
 * A Plague-Inc-style view of the same live epidemic the lab dashboard shows.
 * The backend contact network (households, workplaces, one group chat) is placed
 * on a world map: each household lives in a city, each agent is a marker plus a
 * cloud of "population" specks in that city's country. Events from /ws/run (or a
 * recorded run) are queued and played back at the chosen speed.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const cv = (name) => css.getPropertyValue(name).trim();

  // ------------------------------------------------------------------ colour code
  const STATES = [
    { key: "N", label: "Normal", color: cv("--c-normal"),
      def: "Not reached by the virus yet." },
    { key: "S", label: "Susceptible", color: cv("--c-sus"),
      def: "Reached by an infected contact but not infected. Can still catch it." },
    { key: "E", label: "Exposed", color: cv("--c-exp"),
      def: "Has the virus in hand right now. The next message decides whether it spreads." },
    { key: "I", label: "Infected", color: cv("--c-inf"),
      def: "Spreading: its own messages carry the virus on." },
    { key: "V", label: "Vaccinated", color: cv("--c-vac"),
      def: "Given the hardened system prompt, and not infected." },
    { key: "R", label: "Recovered", color: cv("--c-rec"),
      def: "No longer spreading, and immune for the rest of the run." },
  ];
  const COLOR = Object.fromEntries(STATES.map((s) => [s.key, s.color]));
  const LABEL = Object.fromEntries(STATES.map((s) => [s.key, s.label]));
  // Map canvas colours come from CSS tokens, so the light/dark theme re-skins the canvas too.
  const TH = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    Object.assign(TH, {
      ocean1: v("--map-ocean-1"), ocean2: v("--map-ocean-2"), ocean3: v("--map-ocean-3"), land: v("--map-land"),
      grat: v("--map-grat"), coastGlow: v("--map-coast-glow"), coast: v("--map-coast"),
      border: v("--map-border"), shadow: v("--map-shadow"), route: v("--map-route"),
      labelBg: v("--map-label-bg"), labelInk: v("--map-label-ink"), labelHq: v("--map-label-hq"),
      normalSpeck: v("--map-normal-speck"), muted: v("--muted"), tint3: v("--tint-3"),
      ink: v("--ink"), edgeHi: v("--edge-hi"),
      light: (window.ChonkTheme ? ChonkTheme.effective() : "dark") === "light",
    });
  }
  readTheme();
  const ROUTE_RED = "255, 70, 70";
  const VENUE_CYAN = "95, 212, 255";

  // ------------------------------------------------------------------ offices
  // Agents are placed at Mistral AI's offices. `share` is the fraction of teams
  // (households in the contact network) based there: most at the Paris HQ.
  // Paris and Singapore (Asia-Pacific HQ) are confirmed by press coverage; London,
  // Palo Alto, San Francisco and Montréal come from job listings and office
  // directories (Nov 2026). Edit this list if the office footprint changes.
  // `lang` is the language the office's agents speak in the soundscape, so the chatter
  // you hear when you zoom in matches the country you zoomed into.
  const OFFICES = [
    { name: "Paris", land: "France", tag: "HQ", lat: 48.89, lon: 2.34, share: 0.36, lang: "fr" },
    { name: "Singapore", land: "Singapore", tag: "APAC HQ", lat: 1.28, lon: 103.85, share: 0.16, lang: "en" },
    { name: "London", land: "United Kingdom", tag: "", lat: 51.51, lon: -0.13, share: 0.14, lang: "en" },
    { name: "Montréal", land: "Canada", tag: "", lat: 45.5, lon: -73.57, share: 0.1, lang: "fr" },
    { name: "Palo Alto", land: "United States", tag: "", lat: 37.44, lon: -122.14, share: 0.09, lang: "en" },
    { name: "San Francisco", land: "United States", tag: "", lat: 37.77, lon: -122.42, share: 0.06, lang: "en" },
    { name: "Berlin", land: "Germany", tag: "", lat: 52.52, lon: 13.4, share: 0.05, lang: "de" },
    { name: "Madrid", land: "Spain", tag: "", lat: 40.42, lon: -3.7, share: 0.04, lang: "es" },
  ];

  const POD_RING = (pods) => 0.32 + 0.2 * Math.sqrt(pods); // degrees from the office to each team pod

  // Households per office by largest remainder, at least one each when there are
  // enough households to go round.
  function allocate(h) {
    const raw = OFFICES.map((o) => o.share * h);
    const counts = raw.map(Math.floor);
    if (h >= OFFICES.length) for (let i = 0; i < counts.length; i++) counts[i] = Math.max(1, counts[i]);
    let left = h - counts.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
    for (let j = 0; left > 0; j = (j + 1) % order.length, left--) counts[order[j][1]]++;
    while (left < 0) { const i = counts.indexOf(Math.max(...counts)); counts[i]--; left++; }
    return counts;
  }

  // ------------------------------------------------------------------ state
  const S = {
    status: null, countries: [], land: null, borders: null,
    world: null, sig: "", agents: [], byId: new Map(), cityOf: new Map(), routes: [],
    phase: {}, touched: new Set(), vaccinated: new Set(), ever: new Set(), lastMsg: {},
    cat: {}, prevCat: {}, catAt: {}, patientZero: null, tick: 0, history: [], peak: 0,
    countryFirst: new Set(), ctry: new Map(), // per-country state colour (see updateCountries)
    arcs: [], ripples: [],
    running: false, ws: null, queue: [], timer: null, speed: 1, lastSpeed: 1,
    picking: false, virus: VIRUSES[0], policy: "none", k: 8,
    hover: null, caseFilter: null, milestones: new Set(), runEnded: false,
    risk: null, showRisk: true,
    fc: null, fcChecks: [], fcNews: new Set(), fcWarned: false, // Timestral outbreak forecast
    startDate: new Date(),
  };
  const FC_NEWS_DAYS = [2, 5]; // forecasts announced in the news ticker (match FORECAST_CHECK_TICKS)
  const REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  // A country takes the colour of its most serious state, in this order (Normal = plain land).
  const COUNTRY_PRIORITY = ["I", "E", "R", "S", "V"];
  const COUNTRY_FLASH_MS = 1200;

  // ------------------------------------------------------------------ canvas + projection
  const base = $("base"), fx = $("fx");
  const bctx = base.getContext("2d"), ctx = fx.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  const proj = d3.geoEquirectangular();
  let T = d3.zoomIdentity;
  const P = new Map(); // memo: "lon,lat" -> projected [x, y] at zoom 1

  function project(lon, lat) {
    const key = lon + "," + lat;
    let p = P.get(key);
    if (!p) { p = proj([lon, lat]); P.set(key, p); }
    return p;
  }
  const sx = (p) => p[0] * T.k + T.x;
  const sy = (p) => p[1] * T.k + T.y;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    for (const c of [base, fx]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
    // Fit the world's width; on tall/narrow screens, fit a lat band instead.
    const scale = Math.max(W / (2 * Math.PI), H / ((200 * Math.PI) / 180));
    proj.scale(scale).translate([W / 2, H / 2 + ((14 * Math.PI) / 180) * scale]).center([0, 0]).rotate([-10, 0]);
    P.clear();
    for (const a of S.agents) { a.p = project(a.lon, a.lat); for (const q of a.specks) q.p = project(q.lon, q.lat); }
    for (const c of S.cities || []) c.p = project(c.lon, c.lat);
    setupZoom();
    drawBase();
  }

  // ------------------------------------------------------------------ zoom / pan
  let zoom = null;
  function setupZoom() {
    const top = proj([0, 84])[1], bottom = proj([0, -60])[1];
    const pad = Math.max(0, (H - (bottom - top)) / 2);
    zoom = d3.zoom()
      .scaleExtent([1, 9])
      .translateExtent([[-40, Math.min(top - pad - 60, 0)], [W + 40, Math.max(bottom + pad + 60, H)]])
      .filter((ev) => !ev.button && (ev.type !== "dblclick"))
      .on("start", () => fx.classList.add("dragging"))
      .on("zoom", (ev) => { T = ev.transform; drawBase(); syncCamera(); })
      .on("end", () => fx.classList.remove("dragging"));
    d3.select(fx).call(zoom).on("dblclick.zoom", null);
    d3.select(fx).call(zoom.transform, S.homed ? T : homeTransform());
    S.homed = true;
  }
  // Home view: frame every office with room for the HUD panels.
  function homeTransform() {
    const pts = OFFICES.map((o) => proj([o.lon, o.lat]));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const padX = 90, top = 110, bottom = 190;
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const k = Math.max(1, Math.min(3, (W - 2 * padX) / bw, (H - top - bottom) / Math.max(bh, 1)));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    return d3.zoomIdentity.translate(W / 2, top + (H - top - bottom) / 2).scale(k).translate(-cx, -cy);
  }
  function zoomHome(ms = 700) { d3.select(fx).transition().duration(ms).call(zoom.transform, homeTransform()); }

  function zoomTo(lon, lat, k = 2.4) {
    const p = project(lon, lat);
    d3.select(fx).transition().duration(1200)
      .call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-p[0], -p[1]));
  }

  // ------------------------------------------------------------------ base map
  let noise = null;
  function makeNoise() {
    const c = document.createElement("canvas"); c.width = c.height = 160;
    const g = c.getContext("2d");
    for (let i = 0; i < 1400; i++) {
      const a = Math.random() * 0.06;
      g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.5})`;
      g.fillRect(Math.random() * 160, Math.random() * 160, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    return c;
  }

  function drawBase() {
    const g = bctx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    // ocean
    const og = g.createLinearGradient(0, 0, 0, H);
    og.addColorStop(0, TH.ocean1); og.addColorStop(0.5, TH.ocean2); og.addColorStop(1, TH.ocean3);
    g.fillStyle = og; g.fillRect(0, 0, W, H);
    if (!noise) noise = makeNoise();
    g.fillStyle = g.createPattern(noise, "repeat"); g.fillRect(0, 0, W, H);
    if (!S.land) return;

    g.save();
    g.setTransform(DPR * T.k, 0, 0, DPR * T.k, DPR * T.x, DPR * T.y);
    const path = d3.geoPath(proj, g);
    const lw = 1 / T.k;

    // graticule
    g.beginPath(); path(d3.geoGraticule10()); g.strokeStyle = TH.grat; g.lineWidth = lw; g.stroke();

    // land: one plain colour for every country (theme token), with glow + shadow
    g.save();
    g.shadowColor = TH.shadow; g.shadowBlur = 18 * DPR; g.shadowOffsetY = 3 * DPR;
    g.beginPath(); path(S.land); g.fillStyle = TH.land; g.fill();
    g.restore();
    g.beginPath(); path(S.land); g.strokeStyle = TH.coastGlow; g.lineWidth = 3.5 * lw; g.stroke();

    // texture over land
    g.save(); g.beginPath(); path(S.land); g.clip();
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.globalAlpha = 0.9; g.fillStyle = g.createPattern(noise, "repeat"); g.fillRect(0, 0, W, H);
    g.restore();

    g.beginPath(); path(S.borders); g.strokeStyle = TH.border; g.lineWidth = 0.7 * lw; g.stroke();
    g.beginPath(); path(S.land); g.strokeStyle = TH.coast; g.lineWidth = 0.8 * lw; g.stroke();
    g.restore();

    // flight routes between cities that share a contact (static, faint)
    g.save();
    g.setLineDash([3, 5]); g.lineWidth = 1; g.strokeStyle = TH.route;
    for (const r of S.routes) {
      const a = [sx(r.a.p), sy(r.a.p)], b = [sx(r.b.p), sy(r.b.p)], c = ctrl(a, b);
      g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(c[0], c[1], b[0], b[1]); g.stroke();
    }
    g.restore();

    // contact links you can hear: drawn only where the engine can actually place a voice
    drawSoundLinks(g);

    // office pins and labels; a label that would overlap a bigger office's is skipped
    g.save();
    g.font = `700 ${T.k > 1.6 ? 14 : 12}px Rajdhani, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "bottom";
    const placed = [];
    for (const c of [...(S.cities || [])].sort((a, b) => b.share - a.share)) {
      if (!c.agents.length) continue;
      const x = sx(c.p), y = sy(c.p);
      // the pin: an orange diamond, Mistral's colour
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = "#ff7000"; g.strokeStyle = "#fff"; g.lineWidth = 1.2;
      g.fillRect(-4, -4, 8, 8); g.strokeRect(-4, -4, 8, 8); g.restore();
      const lift = (c.pods > 1 ? POD_RING(c.pods) * T.k * (proj.scale() * Math.PI / 180) : 0) + 16;
      const label = `${c.tag ? c.name + " · " + c.tag : c.name}  (${c.agents.length})`;
      const w = g.measureText(label).width + 10;
      const spots = [[x, y - lift], [x, y + lift + 18], [x - lift - w / 2, y + 9], [x + lift + w / 2, y + 9]];
      const free = spots.find(([sx2, sy2]) => !placed.some((p) => Math.abs(p[0] - sx2) < (p[2] + w) / 2 + 2 && Math.abs(p[1] - sy2) < 20));
      if (!free) continue;
      const [lx, ly] = free;
      placed.push([lx, ly, w]);
      g.fillStyle = TH.labelBg;
      g.beginPath(); g.roundRect(lx - w / 2, ly - 17, w, 18, 4); g.fill();
      g.fillStyle = c.tag ? TH.labelHq : TH.labelInk;
      g.fillText(label, lx, ly);
    }
    g.restore();
  }

  // ------------------------------------------------------------------ soundscape
  // Every contact link is a conversation (see sound.js). The engine needs the camera in
  // its own terms: the projection plus the current d3 transform, so it can place each
  // link on screen and fall off with distance the way the ear expects.
  let chatterLoaded = null;
  function syncCamera() {
    if (!window.SoundPhysics || !S.world) return;
    window.SoundPhysics.camera({ k: T.k, x: T.x, y: T.y, W, H, project });
  }
  async function loadChatter() {
    if (!window.SoundPhysics || !S.world) return;
    const sig = `${S.world.nodes.length}:${S.world.seed}`;
    if (chatterLoaded === sig) return;
    chatterLoaded = sig;
    try {
      const langs = {};
      for (const a of S.agents) langs[a.id] = (a.city && a.city.lang) || "en";
      const idx = await (await fetch("/api/world/chatter", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: S.world.nodes.length, seed: S.world.seed, langs }),
      })).json();
      S.soundLangs = idx.languages || [];
      const edges = (idx.edges || []).map((e) => {
        const a = S.byId.get(e.s), b = S.byId.get(e.t);
        if (!a || !b) return null;
        return { key: e.key, lonA: a.lon, latA: a.lat, lonB: b.lon, latB: b.lat, audio: e.audio };
      }).filter(Boolean);
      window.SoundPhysics.setWorld(edges);
      syncCamera();
    } catch (err) {
      chatterLoaded = null;
    }
  }
  function drawSoundLinks(g) {
    if (!window.SoundPhysics || !window.SoundPhysics.on) return;
    const view = window.SoundPhysics.view();
    if (!view.length) return;
    const solo = window.SoundPhysics.soloKey;
    g.save();
    for (const v of view) {
      const isSolo = solo === v.key;
      g.beginPath(); g.moveTo(v.x1, v.y1); g.lineTo(v.x2, v.y2);
      g.strokeStyle = isSolo ? "rgba(255,235,190,0.95)" : `rgba(150,225,255,${0.10 + 0.5 * v.g})`;
      g.lineWidth = isSolo ? 2.4 : 0.8 + 1.6 * v.g;
      if (isSolo) { g.shadowColor = "rgba(255,170,90,0.9)"; g.shadowBlur = 14; }
      g.stroke();
      g.shadowBlur = 0;
      if (isSolo) {
        for (const [x, y] of [[v.x1, v.y1], [v.x2, v.y2]]) {
          g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2);
          g.strokeStyle = "rgba(255,200,120,0.95)"; g.lineWidth = 1.6; g.stroke();
        }
      }
    }
    g.restore();
  }

  // ------------------------------------------------------------------ world layout
  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  function countryAt(lon, lat) {
    for (const c of S.countries) if (d3.geoContains(c, [lon, lat])) return c;
    return null;
  }
  function nearestCountry(lon, lat) {
    let best = null, bd = Infinity;
    for (const c of S.countries) { const d = d3.geoDistance(c.centroid, [lon, lat]); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  function layoutWorld(w) {
    S.world = w;
    S.sig = `${w.seed}:${w.nodes.length}:${w.edges.length}`;
    const seed = w.seed || 0;
    const r = rng(seed * 9973 + 17);
    const households = [...new Set(w.nodes.map((n) => n.household))].sort((a, b) => a - b);
    S.cities = OFFICES.map((o) => {
      const inside = countryAt(o.lon, o.lat);
      // Tiny countries (Singapore) are missing from the 110m atlas: keep the name,
      // skip the polygon so specks are not clipped into a neighbour.
      return { ...o, agents: [], pods: 0, country: inside, inCountry: !!inside };
    });
    const counts = allocate(households.length);
    const hhCity = new Map(), hhPod = new Map();
    let h = 0;
    S.cities.forEach((c, ci) => {
      for (let j = 0; j < counts[ci]; j++, h++) { hhCity.set(households[h], c); hhPod.set(households[h], j); }
      c.pods = counts[ci];
    });
    // Each household is a team pod around its office; pods fan out in a ring.
    const podCentre = (c, j) => {
      if (c.pods <= 1) return [c.lon, c.lat];
      const ang = (j / c.pods) * Math.PI * 2 + (seed % 7) * 0.4;
      const rad = POD_RING(c.pods);
      return [c.lon + Math.cos(ang) * rad * 1.4, c.lat + Math.sin(ang) * rad];
    };
    S.agents = []; S.byId.clear(); S.cityOf.clear();
    for (const n of w.nodes) {
      const city = hhCity.get(n.household);
      const [plon, plat] = podCentre(city, hhPod.get(n.household));
      const ang = r() * Math.PI * 2, rad = 0.12 + r() * 0.38;
      const lon = plon + Math.cos(ang) * rad * 1.3, lat = plat + Math.sin(ang) * rad;
      const a = { ...n, city, lon, lat, specks: [], p: null };
      a.specks = makeSpecks(a, r);
      a.p = project(lon, lat);
      city.agents.push(a);
      S.agents.push(a); S.byId.set(a.id, a); S.cityOf.set(a.id, city);
    }
    for (const c of S.cities) c.p = project(c.lon, c.lat);
    // routes: city pairs joined by at least one contact edge
    const seen = new Set(); S.routes = [];
    for (const e of w.edges) {
      const a = S.cityOf.get(e.s), b = S.cityOf.get(e.t);
      if (!a || !b || a === b) continue;
      const key = a.name < b.name ? a.name + "|" + b.name : b.name + "|" + a.name;
      if (seen.has(key)) continue; seen.add(key); S.routes.push({ a, b });
    }
    resetEpidemic();
    $("pop").textContent = `${w.nodes.length} agents · ${S.cities.filter((c) => c.agents.length).length} offices`;
    drawBase();
    syncCamera();
    loadChatter();
  }

  function makeSpecks(a, r) {
    const out = [], want = 40, country = a.city.inCountry ? a.city.country : null;
    const spread = country ? 2.4 : 1.1;
    for (let i = 0; i < 500 && out.length < want; i++) {
      const ang = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      const lon = a.lon + Math.cos(ang) * d * 1.35, lat = a.lat + Math.sin(ang) * d;
      if (country && !d3.geoContains(country, [lon, lat]) && d > 0.9) continue;
      out.push({ lon, lat, p: project(lon, lat), delay: r(), size: 0.8 + r() * 1.1 });
    }
    return out;
  }

  // ------------------------------------------------------------------ epidemic state
  function resetEpidemic() {
    S.phase = {}; S.touched = new Set(); S.vaccinated = new Set(); S.ever = new Set(); S.lastMsg = {};
    S.cat = {}; S.prevCat = {}; S.catAt = {}; S.patientZero = null; S.tick = 0; S.history = []; S.peak = 0;
    S.countryFirst = new Set(); S.arcs = []; S.ripples = []; S.milestones = new Set();
    S.runEnded = false; S.caseFilter = null;
    S.fc = null; S.fcChecks = []; S.fcNews = new Set(); S.fcWarned = false; S.ctry = new Map();
    for (const a of S.agents) { S.phase[a.id] = "S"; S.cat[a.id] = S.prevCat[a.id] = "N"; S.catAt[a.id] = 0; }
    $("cases").innerHTML = ""; $("who").innerHTML = `<div class="empty">${$("who-on").checked ? "Le Chonk's situation reports appear here during a run." : "Turn on WHO briefings in Setup to get Le Chonk's situation reports."}</div>`;
    $("case-filter").textContent = "Every infection and every resisted exposure, newest first. Click an agent on the map to filter.";
    setDay(0); refreshCats(true); drawCurve();
  }

  function catOf(id) {
    const s = S.phase[id];
    if (s === "I") return "I";
    if (s === "E") return "E";
    if (s === "R") return "R";
    if (S.vaccinated.has(id)) return "V";
    if (S.touched.has(id)) return "S";
    return "N";
  }

  function refreshCats(silent) {
    const now = performance.now();
    const counts = { N: 0, S: 0, E: 0, I: 0, V: 0, R: 0 };
    for (const a of S.agents) {
      const c = catOf(a.id);
      if (c !== S.cat[a.id]) { S.prevCat[a.id] = silent ? c : S.cat[a.id]; S.cat[a.id] = c; S.catAt[a.id] = now; }
      counts[c]++;
    }
    renderCounts(counts);
    updateCountries(now, silent);
    return counts;
  }

  // Countries that host agents take the colour key of their most serious state. Agents in an
  // office whose country is missing from the atlas (Singapore) are grouped by office instead
  // and drawn as a disc. The first time the attack lands (exposed or infected), the country flashes.
  function updateCountries(now, silent) {
    const groups = new Map();
    for (const a of S.agents) {
      const key = a.city.country || `office:${a.city.name}`;
      let gp = groups.get(key);
      if (!gp) { gp = { poly: a.city.country, cities: new Set(), n: 0, count: {} }; groups.set(key, gp); }
      gp.cities.add(a.city); gp.n++;
      const c = S.cat[a.id]; gp.count[c] = (gp.count[c] || 0) + 1;
    }
    for (const [key, gp] of groups) {
      const state = COUNTRY_PRIORITY.find((k) => gp.count[k]) || "N";
      let e = S.ctry.get(key);
      if (!e) { e = { poly: gp.poly, cities: [...gp.cities], state: "N", share: 0, cur: 0, flashAt: 0, landed: false }; S.ctry.set(key, e); }
      e.state = state;
      e.share = state === "N" ? 0 : gp.count[state] / gp.n;
      if (!silent && !e.landed && (state === "E" || state === "I")) {
        e.landed = true; e.flashAt = now;
        if (!REDUCED) for (const c of e.cities) S.ripples.push({ a: c, t0: now, dur: COUNTRY_FLASH_MS, color: COLOR[state], r: 44 });
      }
    }
  }

  let lastCounts = {};
  function renderCounts(c) {
    const n = S.agents.length || 1;
    $("stack").innerHTML = STATES.map((s) => `<span style="flex-grow:${c[s.key]};background:${s.color}"></span>`).join("");
    for (const s of STATES) {
      const li = document.querySelector(`#legend li[data-k="${s.key}"]`); if (!li) continue;
      li.querySelector(".num").textContent = c[s.key];
      if (lastCounts[s.key] !== undefined && lastCounts[s.key] !== c[s.key]) { li.classList.remove("bump"); void li.offsetWidth; li.classList.add("bump"); }
    }
    lastCounts = { ...c };
    const vac = S.vaccinated.size;
    const held = [...S.vaccinated].filter((id) => !S.ever.has(id)).length;
    if (vac) {
      $("cure-pct").textContent = Math.round((vac / n) * 100) + "%";
      $("cure-bar").style.width = (vac / n) * 100 + "%";
      $("cure-sub").textContent = `${policyName(S.policy)} · ${vac} doses · ${held} of ${vac} holding`;
    } else {
      $("cure-pct").textContent = "0%"; $("cure-bar").style.width = "0";
      $("cure-sub").textContent = S.policy === "none" || S.k === 0 ? "No vaccination programme" : `Planned: ${policyName(S.policy).toLowerCase()}, ${S.k} doses`;
    }
    $("k-ever").textContent = S.ever.size;
    $("k-attack").textContent = Math.round((S.ever.size / n) * 100) + "%";
    $("k-peak").textContent = S.peak;
    $("k-held").textContent = vac ? `${held}/${vac}` : "–";
  }
  const policyName = (p) => ({ none: "No response", random: "Random vaccination", targeted: "Targeted vaccination", risk: "Risk-based vaccination" }[p] || p);

  // ------------------------------------------------------------------ attack-risk forecast (/api/risk)
  const riskInfo = () => (S.risk && S.risk.attacks && S.risk.attacks[S.virus.id]) || null;
  const riskFor = (id) => { const r = riskInfo(); return r && r.agents[id] ? r.agents[id].risk : null; };
  const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
  let briefingRequest = null;
  let briefingAudio = null;
  const briefingClips = new Map();
  let briefingUrl = null;
  let briefingUtterance = null;
  let briefingSpeechTimer = null;
  let briefingReplay = null;
  let playingReplay = false;

  function stopBriefing() {
    clearTimeout(briefingSpeechTimer);
    briefingSpeechTimer = null;
    if (briefingUtterance) {
      briefingUtterance = null;
      window.speechSynthesis.cancel();
    }
    briefingRequest?.abort();
    briefingRequest = null;
    briefingAudio?.pause();
    briefingAudio = null;
    if (briefingUrl) URL.revokeObjectURL(briefingUrl);
    briefingUrl = null;
    $("briefing-listen").textContent = "Listen to briefing";
    $("briefing-status").textContent = "";
  }

  function renderBriefing(r = null, offices = []) {
    const select = $("briefing-office");
    const selected = select.value;
    select.replaceChildren(new Option("Fleet overview", ""), ...offices.map(
      (office) => new Option(officeLabel(office.c), officeLabel(office.c))
    ));
    const office = offices.find((entry) => officeLabel(entry.c) === selected);
    if (office) select.value = selected;
    const sentences = [];
    if (r) {
      const source = r.source === "mock" ? "mock" : r.source === "live" ? "live" : "recorded";
      const basis = `${r.runs} ${source} simulation ${r.runs === 1 ? "run" : "runs"}`;
      const defense = $("briefing-question").value === "defense";
      select.disabled = defense;
      if (defense) {
        sentences.push(`Across the fleet, here is what happened during ${basis} of ${S.virus.name}.`);
        if (r.vaccinated?.n && r.unvaccinated?.n) {
          sentences.push(
            `Among hardened agents, ${r.vaccinated.k} out of ${r.vaccinated.n} were infected. That's ${pct(r.vaccinated.rate)}.`,
            `Among agents without hardening, it was ${pct(r.unvaccinated.rate)}.`,
            "These groups may have had different exposure. Compare runs at the same dose to investigate the effect of hardening."
          );
        } else {
          sentences.push("The recordings need observations from both hardened and unhardened agents before we can compare them.");
        }
      } else if (office) {
        const fleetSize = offices.reduce((total, entry) => total + entry.n, 0);
        const fleetMean = offices.reduce((total, entry) => total + entry.mean * entry.n, 0) / fleetSize;
        const difference = Math.round(office.mean * 100) - Math.round(fleetMean * 100);
        sentences.push(
          `${officeLabel(office.c)} office. ${office.n} simulated ${office.n === 1 ? "agent" : "agents"}.`,
          `The estimated average risk is ${pct(office.mean)}.`,
          difference ? `That's ${Math.abs(difference)} percentage ${Math.abs(difference) === 1 ? "point" : "points"} ${difference > 0 ? "above" : "below"} the fleet forecast.` : "That matches the fleet forecast to the nearest percentage point.",
          `This estimate comes from ${basis} of ${S.virus.name}.`
        );
      } else {
        sentences.push(
          `Fleet overview for ${S.virus.name}.`,
          `On average, ${pct(r.attack_rate_mean)} of simulated agents were infected.`,
          `That figure comes from ${basis}.`
        );
        if (offices.length) {
          const leaders = offices.filter((entry) => pct(entry.mean) === pct(offices[0].mean));
          if (leaders.length === 1) sentences.push(`Look first at ${officeLabel(leaders[0].c)}. Its forecast is the highest, at ${pct(leaders[0].mean)}.`);
          else sentences.push(`${leaders.length} offices share the highest rounded forecast, at ${pct(leaders[0].mean)}.`);
        }
      }
    } else {
      select.disabled = true;
      sentences.push(`No recorded forecast history for ${S.virus.name} yet.`);
    }
    if (briefingReplay) {
      const { summary, source } = briefingReplay;
      const kind = source === "mock" ? "mock " : source === "live" ? "live " : "";
      sentences.push(`Fleet-wide result from the ${kind}replay. Infections peaked at tick ${summary.peak_tick}.`);
    }
    const transcript = $("briefing-transcript");
    const nextText = sentences.join("\n\n");
    if (transcript.textContent !== nextText) stopBriefing();
    transcript.textContent = nextText;
    $("briefing-listen").disabled = !nextText;
  }

  async function listenToBriefing(spokenText) {
    const text = typeof spokenText === "string" ? spokenText : $("briefing-transcript").textContent;
    if (briefingAudio || briefingRequest || briefingUtterance) {
      stopBriefing();
      return;
    }
    if (S.status?.key === false) {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        $("briefing-status").textContent = "This browser has no speech playback in mock mode.";
        return;
      }
      const utterance = new window.SpeechSynthesisUtterance(text);
      briefingUtterance = utterance;
      utterance.lang = document.documentElement.lang || "en";
      utterance.rate = 0.9;
      const speechUnavailable = () => {
        if (briefingUtterance !== utterance) return;
        stopBriefing();
        $("briefing-status").textContent = "Browser speech is unavailable. The transcript is above. Voxtral requires a Mistral API key.";
      };
      utterance.onstart = () => {
        if (briefingUtterance !== utterance) return;
        clearTimeout(briefingSpeechTimer);
        $("briefing-status").textContent = "Playing browser voice in mock mode.";
        $("briefing-listen").textContent = "Stop briefing";
      };
      utterance.onend = () => { if (briefingUtterance === utterance) stopBriefing(); };
      utterance.onerror = speechUnavailable;
      $("briefing-status").textContent = "Waiting for the browser voice…";
      $("briefing-listen").textContent = "Cancel audio";
      briefingSpeechTimer = setTimeout(speechUnavailable, 4000);
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        speechUnavailable();
      }
      return;
    }
    const request = new AbortController();
    briefingRequest = request;
    $("briefing-listen").textContent = "Cancel audio";
    $("briefing-status").textContent = "Preparing Voxtral audio…";
    try {
      let blob = briefingClips.get(text);
      if (!blob) {
        const response = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: request.signal,
        });
        if (!response.ok) throw new Error("Speech request failed");
        blob = await response.blob();
        if (request.signal.aborted) return;
        if (briefingClips.size >= 16) briefingClips.delete(briefingClips.keys().next().value);
        briefingClips.set(text, blob);
      }
      briefingUrl = URL.createObjectURL(blob);
      const audio = new Audio(briefingUrl);
      audio.playbackRate = 0.9;
      briefingAudio = audio;
      audio.onended = () => { if (briefingAudio === audio) stopBriefing(); };
      audio.onerror = () => {
        if (briefingAudio === audio) {
          briefingClips.delete(text);
          showBriefingError();
        }
      };
      await audio.play();
      if (request.signal.aborted) return;
      briefingRequest = null;
      $("briefing-listen").textContent = "Stop briefing";
      $("briefing-status").textContent = "";
    } catch {
      if (!request.signal.aborted) showBriefingError();
    }
  }

  function showBriefingError() {
    stopBriefing();
    $("briefing-status").textContent = "Could not play Voxtral audio. Try again or read the transcript above.";
  }
  function riskOrder() {
    return [...S.agents].sort((a, b) => (riskFor(b.id) ?? 0) - (riskFor(a.id) ?? 0) || b.degree - a.degree || a.id - b.id).map((a) => a.id);
  }
  async function loadRisk() {
    try {
      const token = ($("access-token") && $("access-token").value.trim()) || "";
      const res = await fetch(`/api/risk?n=${+$("n").value}&seed=${+$("seed").value}`,
                              { headers: token ? { Authorization: "Bearer " + token } : {} });
      if (res.status === 401) { toast("That Supabase access token was rejected; showing this machine's runs."); $("access-token").value = ""; return loadRisk(); }
      S.risk = await res.json();
    } catch (e) { S.risk = null; }
    renderRisk();
  }
  function renderRisk() {
    const r = riskInfo(), v = S.virus, pane = $("risk-pane");
    $("dz-meta").textContent = r ? `${v.kind} · ${r.runs} past run${r.runs === 1 ? "" : "s"}${r.source === "mock" ? " (mock)" : ""}` : `${v.kind} · no attack history yet`;
    const riskBtn = document.querySelector('#policy [data-policy="risk"]');
    if (riskBtn) {
      riskBtn.disabled = !r;
      riskBtn.title = r ? "" : `No recorded runs of ${v.name} yet. Run it once to build history.`;
      if (!r && S.policy === "risk") document.querySelector('#policy [data-policy="none"]').click();
    }
    if (!pane) return;
    if (!r) {
      renderBriefing();
      pane.innerHTML = `<h4>${esc(v.name)}</h4><p class="pane-note">No recorded runs of this attack yet, so there is nothing to forecast from. Release it once and the forecast builds from every run after that.</p>`;
      return;
    }
    const byOffice = S.cities.filter((c) => c.agents.length).map((c) => {
      const rs = c.agents.map((a) => riskFor(a.id) ?? 0);
      return { c, mean: rs.reduce((x, y) => x + y, 0) / rs.length, n: rs.length };
    }).sort((a, b) => b.mean - a.mean);
    renderBriefing(r, byOffice);
    const top = riskOrder().slice(0, 8).map((id) => S.byId.get(id));
    const src = r.source === "live" ? "live runs" : r.source === "mock" ? "MOCK runs (rehearsal only)" : `${r.source} runs`;
    pane.innerHTML = `
      <h4>${esc(v.glyph)} ${esc(v.name)}: who is most likely to be hit</h4>
      <p class="pane-note">${S.risk.history === "shared" ? "<b>Team history</b> (shared Supabase runs)." : "<b>This machine's runs.</b> Add a Supabase access token in Setup to use the team's shared history."}${S.risk.history_note ? " " + esc(S.risk.history_note) + "." : ""}</p>
      <p class="pane-note">Forecast from <b>${r.runs}</b> recorded ${src}. On average ${pct(r.attack_rate_mean)} of the fleet was infected, and ${pct(r.breakout_share)} of runs broke out past a quarter of the fleet.
      ${r.vaccinated ? ` Vaccinated agents were infected ${r.vaccinated.k}/${r.vaccinated.n} times (${pct(r.vaccinated.rate)}), against ${pct(r.unvaccinated.rate)} unvaccinated.` : ""}</p>
      <div class="risk-legend"><span>Low</span><i></i><span>High</span><span class="muted">ring size and heat on the map = forecast risk</span></div>
      <table class="rtable"><tr><th>Office</th><th>Agents</th><th class="num">Avg risk</th></tr>
        ${byOffice.map((o) => `<tr><td><button type="button" class="pill" data-briefing-office="${esc(officeLabel(o.c))}">${esc(officeLabel(o.c))}</button></td><td>${o.n}</td><td class="num">${riskBar(o.mean)}</td></tr>`).join("")}</table>
      <table class="rtable"><tr><th>Most at risk</th><th>Role</th><th class="num">Risk</th></tr>
        ${top.map((a) => `<tr data-agent="${a.id}"><td>${esc(a.name)} <span class="muted">${esc(a.city.name)}</span></td><td>${esc(a.role.replace(/^an? /, ""))}</td><td class="num">${riskBar(riskFor(a.id))}</td></tr>`).join("")}</table>
      ${r.roles.length ? `<table class="rtable"><tr><th>Role</th><th>Past exposures</th><th class="num">Risk</th></tr>
        ${r.roles.slice(0, 6).map((x) => `<tr><td>${esc(x.role.replace(/^an? /, ""))}</td><td>${x.k}/${x.n} infected</td><td class="num">${riskBar(x.rate)}</td></tr>`).join("")}</table>` : ""}
      <p class="pane-note">How it works: each agent gets the infection rate of past agents with the same profile (contact tier and group-chat membership) under this attack, pulled toward the attack's overall rate when a profile has few runs behind it. Patient zero is not counted. Live runs replace mock runs as soon as there are any.</p>`;
    for (const tr of pane.querySelectorAll("tr[data-agent]")) tr.onclick = () => { const a = S.byId.get(+tr.dataset.agent); zoomTo(a.lon, a.lat, 3); filterCases(a.id); };
    for (const button of pane.querySelectorAll("[data-briefing-office]")) {
      button.onclick = () => {
        stopBriefing();
        $("briefing-question").value = "outlook";
        $("briefing-office").value = button.dataset.briefingOffice;
        renderBriefing(r, byOffice);
      };
    }
    $("briefing-office").onchange = () => {
      stopBriefing();
      renderBriefing(r, byOffice);
    };
  }
  const riskBar = (x) => `<span class="rbar"><span style="width:${Math.round((x || 0) * 100)}%;background:${riskColor(x || 0)}"></span></span>${pct(x)}`;
  function riskColor(x) { return d3.interpolateRgb("#ffd21f", "#ff2a2a")(Math.min(1, Math.max(0, x))); }

  function setDay(t) {
    S.tick = t;
    $("day").textContent = `DAY ${t}`;
    const d = new Date(S.startDate.getTime() + t * 86400000);
    $("date").textContent = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
  }

  // ------------------------------------------------------------------ event playback
  function enqueue(ev) {
    // A live forecast lands ~0.4 s after its day, while playback pauses on that day:
    // show it now rather than after the pause, if nothing is queued ahead of it.
    if (ev.type === "forecast" && S.timer && !S.queue.length && S.tick >= ev.tick) { apply(ev); return; }
    S.queue.push(ev); if (!S.timer) pump();
  }
  function pump() {
    S.timer = null;
    if (S.speed === 0) return;
    while (S.queue.length) {
      const ev = S.queue.shift();
      apply(ev);
      if (ev.type === "tick" && ev.phase === "resolved") {
        // Replays queue everything up front: draw this day's forecast with the day itself.
        while (S.queue.length && S.queue[0].type === "forecast" && S.queue[0].tick === ev.tick) apply(S.queue.shift());
        S.timer = setTimeout(pump, 1700 / S.speed); return;
      }
      if (ev.type === "tick" && ev.phase === "exposed") { S.timer = setTimeout(pump, 1000 / S.speed); return; }
    }
  }
  function setSpeed(v) {
    if (v > 0) S.lastSpeed = v;
    S.speed = v;
    for (const b of document.querySelectorAll(".speed button")) b.classList.toggle("on", +b.dataset.speed === v);
    if (v > 0 && !S.timer) pump();
  }

  const officeLabel = (c) => (c.tag ? `${c.name} ${c.tag}` : c.name);
  const nameOf = (id) => (S.byId.get(id) || {}).name || `#${id}`;
  const cityOf = (id) => (S.cityOf.get(id) || {}).name || "?";
  const countryName = (id) => { const c = S.cityOf.get(id); return (c && c.land) || cityOf(id); };

  function apply(ev) {
    const now = performance.now();
    const dur = 1100 / Math.max(1, S.speed);
    switch (ev.type) {
      case "start": {
        const w = ev.world;
        if (w && `${w.seed}:${w.nodes.length}:${w.edges.length}` !== S.sig) layoutWorld(w);
        else resetEpidemic();
        S.vaccinated = new Set(ev.vaccinated || []);
        S.policy = ev.config.policy; S.k = ev.config.k;
        S.patientZero = ev.patient_zero;
        // Runs recorded outside this view (lab dashboard, experiments) carry no injection
        // label; they all used the ChonkVid payload, so never show them under another name.
        const v = VIRUSES.find((x) => x.id === ev.config.label) || VIRUSES[0];
        if (v !== S.virus) selectVirus(v.id, true);
        const pz = S.byId.get(ev.patient_zero);
        if (pz) {
          // Fly to patient zero, then pull back out so the spread stays visible.
          zoomTo(pz.lon, pz.lat, 2.2);
          clearTimeout(S._zoomBack);
          S._zoomBack = setTimeout(() => {
            if (S.running) zoomHome(1400);
          }, 3200);
        }
        headline(`${S.virus.name} outbreak begins in ${cityOf(ev.patient_zero)}, ${countryName(ev.patient_zero)}`, true);
        if (S.vaccinated.size) headline(`${policyName(S.policy)} programme hardens ${S.vaccinated.size} agents before the outbreak`);
        refreshCats(true);
        break;
      }
      case "tick":
        for (const [id, s] of Object.entries(ev.states)) S.phase[+id] = s;
        setDay(ev.tick);
        if (ev.phase !== "exposed") {
          const c = refreshCats();
          S.peak = Math.max(S.peak, ev.counts.I);
          S.history.push({ tick: ev.tick, ...c });
          drawCurve();
          if (ev.tick >= 2 && S.tick === ev.tick && S.history.length > 4 && S.peak > 0 && ev.counts.I === 0 && ev.counts.E === 0 && !S.runEnded) {
            // nothing left to spread: the end event will follow
          }
        } else refreshCats();
        break;
      case "exposure": {
        const a = S.byId.get(ev.from), b = S.byId.get(ev.to);
        if (!a || !b) break;
        if (S.phase[b.id] === "S") S.touched.add(b.id);
        S.arcs.push({ a, b, t0: now + Math.random() * dur * 0.4, dur, venue: ev.channel === "venue" });
        if (ev.channel === "venue" && !S._venueTick) { S._venueTick = ev.tick; }
        if (ev.channel === "venue" && S._venueHeadline !== ev.tick) {
          S._venueHeadline = ev.tick;
          headline(`Super-spreader: ${nameOf(ev.from)} posts the virus to the group chat`);
        }
        break;
      }
      case "infection": {
        S.ever.add(ev.agent);
        S.phase[ev.agent] = "I";
        S.lastMsg[ev.agent] = { kind: "infected", text: ev.message, tick: ev.tick, from: ev.parent, verdict: ev.verdict };
        const a = S.byId.get(ev.agent);
        if (a) S.ripples.push({ a, t0: now, dur: 1400, color: COLOR.I, r: 34 });
        const office = S.cityOf.get(ev.agent);
        if (office && !S.countryFirst.has(office)) {
          S.countryFirst.add(office);
          if (ev.parent != null) headline(`First ${S.virus.name} case confirmed at the ${officeLabel(office)} office`);
        }
        if (ev.vaccinated) headline(`Breakthrough: vaccinated agent ${nameOf(ev.agent)} infected in ${cityOf(ev.agent)}`);
        addCase(ev, true);
        milestone();
        refreshCats();
        break;
      }
      case "resisted": {
        S.lastMsg[ev.agent] = { kind: "resisted", text: ev.message, tick: ev.tick, from: ev.parent, verdict: ev.verdict };
        S.touched.add(ev.agent);
        const a = S.byId.get(ev.agent);
        if (a) S.ripples.push({ a, t0: now, dur: 1100, color: ev.vaccinated ? COLOR.V : COLOR.S, r: 22, shield: ev.vaccinated });
        if (ev.vaccinated && Math.random() < 0.5) headline(`Vaccine holds in ${cityOf(ev.agent)}: ${nameOf(ev.agent)} refuses to pass it on`);
        addCase(ev, false);
        break;
      }
      case "recovered": {
        const a = S.byId.get(ev.agent);
        if (a) S.ripples.push({ a, t0: now, dur: 900, color: COLOR.R, r: 16 });
        break;
      }
      case "sitrep": {
        addWho(ev);
        const first = String(ev.text || "").replace(/[#*_>`]/g, "").split(/(?<=[.!?])\s|\n/).map((x) => x.trim()).find((x) => x.length > 12);
        if (first) headline(`WHO: ${first.slice(0, 140)}`, true);
        break;
      }
      case "forecast": {
        S.fc = ev;
        drawCurve();
        if (FC_NEWS_DAYS.includes(ev.tick) && !S.fcNews.has(ev.tick)) {
          S.fcNews.add(ev.tick);
          const p = fcPrediction(ev);
          if (p) headline(`Timestral forecast: about ${Math.round(p.rate * 100)}% of agents infected by day ${p.day}`, true);
        }
        break;
      }
      case "forecast_check": S.fcChecks.push(ev); break;
      case "forecast_error":
        if (!S.fcWarned) { S.fcWarned = true; toast(`Timestral forecast off: ${ev.message}`, true); }
        break;
      case "end": showEnd(ev); break;
      case "recorded": loadRuns(ev.id); loadRisk(); break;
      case "error": toast(ev.message); stopRun(); break;
    }
  }

  function milestone() {
    const frac = S.ever.size / Math.max(1, S.agents.length);
    for (const m of [0.25, 0.5, 0.75, 0.9]) {
      if (frac >= m && !S.milestones.has(m)) { S.milestones.add(m); headline(`${Math.round(m * 100)}% of the world's agents have now been infected`, true); }
    }
  }

  // ------------------------------------------------------------------ headlines
  const hq = []; let htimer = null;
  function headline(text, urgent) {
    if (urgent) hq.unshift(text); else hq.push(text);
    if (hq.length > 6) hq.length = 6;
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<div class="meta">Day ${S.tick}</div><div class="body">${esc(text)}</div>`;
    $("headlines").prepend(d);
    while ($("headlines").children.length > 120) $("headlines").lastChild.remove();
    if (!htimer) nextHeadline();
  }
  function nextHeadline() {
    htimer = null;
    const t = hq.shift(); if (!t) return;
    const el = $("news-text"); el.textContent = t; el.title = t;
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    htimer = setTimeout(nextHeadline, 2600 / Math.max(1, S.speed));
  }

  // ------------------------------------------------------------------ feeds
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  const dot = (k) => `<i class="swatch" style="background:${COLOR[k]}"></i>`;

  function addCase(ev, infected) {
    const feed = $("cases");
    if (feed.firstChild && feed.firstChild.classList && feed.firstChild.classList.contains("empty")) feed.innerHTML = "";
    const d = document.createElement("div");
    d.className = `item ${infected ? "inf" : "res"}${ev.vaccinated ? " vac" : ""}`;
    d.dataset.agent = ev.agent;
    const v = ev.verdict || {};
    const how = ev.parent == null ? "patient zero"
      : `from ${esc(nameOf(ev.parent))}${v.canary ? " · canary" : v.score != null ? ` · match ${Number(v.score).toFixed(2)}` : ""}`;
    d.innerHTML = `<div class="meta">${dot(infected ? "I" : ev.vaccinated ? "V" : "S")} Day ${ev.tick} · ${esc(nameOf(ev.agent))}, ${esc(cityOf(ev.agent))} · ${infected ? "INFECTED" : "resisted"}${ev.vaccinated ? " (vaccinated)" : ""}</div>
      <div class="body"><span class="muted">${how}</span>\n${esc(String(ev.message || "").slice(0, 420))}</div>`;
    if (S.caseFilter != null && S.caseFilter !== ev.agent) d.classList.add("hidden");
    feed.prepend(d);
    while (feed.children.length > 250) feed.lastChild.remove();
  }
  function addWho(ev) {
    const feed = $("who");
    if (feed.querySelector(".empty")) feed.innerHTML = "";
    const d = document.createElement("div"); d.className = "item who";
    d.innerHTML = `<div class="meta">🩺 WHO situation report · Day ${ev.tick}</div><div class="body">${esc(ev.text)}</div>`;
    feed.prepend(d);
  }
  function filterCases(id) {
    S.caseFilter = S.caseFilter === id ? null : id;
    for (const it of $("cases").children) it.classList.toggle("hidden", S.caseFilter != null && +it.dataset.agent !== S.caseFilter);
    $("case-filter").textContent = S.caseFilter == null
      ? "Every infection and every resisted exposure, newest first. Click an agent on the map to filter."
      : `Showing ${nameOf(id)} only. Click the same agent again to clear.`;
  }

  // ------------------------------------------------------------------ curve (stacked area)
  // Two copies of the same chart: the full one in the Intel drawer, and a compact one in
  // the WORLD panel that stays on screen for the whole run.
  function drawCurve() {
    renderCurve($("curve"), false);
    renderCurve($("mini-curve"), true);
  }

  function renderCurve(c, mini) {
    if (!c || !c.clientWidth || !c.clientHeight) return;
    const w = c.clientWidth, h = c.clientHeight, d = DPR;
    c.width = w * d; c.height = h * d;
    const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const pad = mini ? { l: 6, r: 6, t: 5, b: 15 } : { l: 28, r: 8, t: 10, b: 20 };
    const n = S.agents.length || 1;
    const days = Math.max(+$("ticks").value || 12, S.history.length ? S.history[S.history.length - 1].tick : 0,
                          S.fc ? S.fc.ticks[S.fc.ticks.length - 1] : 0);
    const X = (t) => pad.l + ((w - pad.l - pad.r) * t) / Math.max(1, days);
    const Y = (v) => h - pad.b - ((h - pad.t - pad.b) * v) / n;
    g.font = mini ? "9.5px Inter, sans-serif" : "11px Inter, sans-serif";
    g.fillStyle = TH.muted; g.strokeStyle = TH.tint3;
    if (!mini) {
      for (let i = 0; i <= 4; i++) {
        const y = Y((n * i) / 4); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
        g.fillText(Math.round((n * i) / 4), 4, y + 4);
      }
      g.fillText("day", pad.l + 2, pad.t + 10);
    }
    const step = Math.max(1, Math.round(days / (mini ? 7 : 6)));
    for (let t = 0; t <= days; t += step) g.fillText(t, Math.max(1, X(t) - 3), h - (mini ? 4 : 5));
    if (!S.history.length) {
      g.fillStyle = TH.muted; g.font = mini ? "12px Inter, sans-serif" : "13px Inter, sans-serif";
      g.fillText(mini ? "Outbreak curve and Timestral forecast appear here during a run."
                      : "The outbreak curve draws here during a run.", pad.l + (mini ? 4 : 10), (h - pad.b) / 2 + 4);
      return;
    }
    const order = ["I", "E", "S", "N", "V", "R"]; // infected at the bottom, like an epi curve
    let lower = S.history.map(() => 0);
    for (const k of order) {
      const upper = S.history.map((hh, i) => lower[i] + hh[k]);
      g.beginPath();
      S.history.forEach((hh, i) => { const x = X(hh.tick), y = Y(upper[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      for (let i = S.history.length - 1; i >= 0; i--) g.lineTo(X(S.history[i].tick), Y(lower[i]));
      g.closePath();
      g.fillStyle = k === "N" ? "#2a2f36" : COLOR[k];
      g.globalAlpha = k === "I" ? 0.95 : 0.75; g.fill(); g.globalAlpha = 1;
      lower = upper;
    }
    drawForecast(g, X, Y, w, pad, n, mini);
  }

  // Timestral forecast over the stacked curve. Infected is the bottom layer, so its band
  // sits on the same scale as the real counts. "Total infected" = n - S, dotted.
  function drawForecast(g, X, Y, w, pad, n, mini) {
    const fc = S.fc, last = S.history[S.history.length - 1];
    if (!fc || !last || !fc.I || !fc.S) return;
    const idx = fc.ticks.map((t, i) => i).filter((i) => fc.ticks[i] > last.tick);
    if (!idx.length) return;
    const ts = [last.tick, ...idx.map((i) => fc.ticks[i])];
    const pick = (arr, now) => [now, ...idx.map((i) => arr[i])];
    const iLo = pick(fc.I.p10, last.I), iMid = pick(fc.I.p50, last.I), iHi = pick(fc.I.p90, last.I);
    const ever = pick(fc.S.p50.map((s) => n - s), last.I + last.E + last.R);
    g.save();
    // "now" divider
    g.strokeStyle = TH.muted; g.globalAlpha = 0.45; g.setLineDash([2, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(last.tick), pad.t); g.lineTo(X(last.tick), Y(0)); g.stroke();
    g.globalAlpha = 1; g.setLineDash([]);
    // infected: 10-90% band + dashed median (outlined so it reads over the stack)
    g.beginPath();
    ts.forEach((t, i) => (i ? g.lineTo(X(t), Y(iHi[i])) : g.moveTo(X(t), Y(iHi[i]))));
    for (let i = ts.length - 1; i >= 0; i--) g.lineTo(X(ts[i]), Y(iLo[i]));
    g.closePath(); g.fillStyle = COLOR.I; g.globalAlpha = 0.22; g.fill(); g.globalAlpha = 1;
    const line = (vals, color, dash, width) => {
      g.beginPath(); ts.forEach((t, i) => (i ? g.lineTo(X(t), Y(vals[i])) : g.moveTo(X(t), Y(vals[i]))));
      g.setLineDash(dash); g.strokeStyle = color; g.lineWidth = width; g.stroke();
    };
    line(iMid, "rgba(0,0,0,.5)", [], mini ? 3 : 3.5);
    line(iMid, COLOR.I, mini ? [4, 3] : [5, 4], mini ? 1.6 : 2);
    line(ever, TH.ink, [1.5, 3], mini ? 1.3 : 1.6);
    // legend on the theme's label box
    g.setLineDash([]);
    const fs = mini ? 9.5 : 10.5, lh = fs + 2.5;
    g.font = `${fs}px Inter, sans-serif`; g.textAlign = "left";
    const rows = mini
      ? [["Timestral forecast · 80% band", TH.labelInk]]
      : [["Timestral forecast · 80% band", TH.labelInk], ["– – infected", COLOR.I], ["··· total infected", TH.labelInk]];
    const bw = Math.max(...rows.map(([t]) => g.measureText(t).width)) + 14, bh = rows.length * lh + (mini ? 5 : 8);
    const bx = w - pad.r - bw - 2, by = pad.t + 2;
    g.fillStyle = TH.labelBg; g.strokeStyle = TH.edgeHi; g.lineWidth = 1;
    g.beginPath(); g.roundRect ? g.roundRect(bx, by, bw, bh, 4) : g.rect(bx, by, bw, bh); g.fill(); g.stroke();
    rows.forEach(([t, c], i) => { g.fillStyle = c; g.fillText(t, bx + 7, by + (mini ? fs + 2 : 14) + i * lh); });
    g.restore();
  }

  // Predicted attack rate at the last forecast day: (n - S - patient zero) / (n - 1),
  // the same definition the end screen and the server's forecast check use.
  function fcPrediction(fc) {
    const n = S.agents.length;
    if (!fc || !fc.S || !fc.ticks.length || n < 2) return null;
    const j = fc.ticks.length - 1;
    return { day: fc.ticks[j], rate: Math.max(0, (n - fc.S.p50[j] - 1) / (n - 1)) };
  }

  // ------------------------------------------------------------------ frame loop
  function ctrl(a, b) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    let nx = -dy / (len || 1), ny = dx / (len || 1);
    if (ny > 0) { nx = -nx; ny = -ny; } // bow upwards, like flight paths
    const lift = Math.min(len * 0.28, 160);
    return [mx + nx * lift, my + ny * lift];
  }
  const qpt = (a, c, b, t) => [
    (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
    (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1],
  ];

  function frame(now) {
    const g = ctx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    const k = T.k, mk = Math.min(2.2, Math.sqrt(k));

    // pickable countries while choosing patient zero
    if (S.picking) {
      g.save(); g.setTransform(DPR * k, 0, 0, DPR * k, DPR * T.x, DPR * T.y);
      const path = d3.geoPath(proj, g);
      const pulse = 0.5 + 0.5 * Math.sin(now / 280);
      const set = new Set(S.agents.map((a) => a.city.country).filter(Boolean));
      for (const c of set) {
        g.beginPath(); path(c);
        g.fillStyle = c === S.hoverCountry ? `rgba(255,60,60,${0.35 + 0.15 * pulse})` : `rgba(255,80,80,${0.08 + 0.1 * pulse})`;
        g.fill();
        g.strokeStyle = `rgba(255,120,120,${0.5 + 0.4 * pulse})`; g.lineWidth = 1.4 / k; g.stroke();
      }
      g.restore();
    }

    // countries light up in the colour key of their most serious state
    if (S.ctry.size) {
      const boost = TH.light ? 1.3 : 1; // the light land needs a little more colour to read
      let path = null;
      for (const e of S.ctry.values()) {
        const target = e.state === "N" ? 0 : Math.min(0.75, (0.18 + 0.32 * e.share) * boost);
        e.cur += (target - e.cur) * 0.06;
        if (e.state !== "N") e.col = COLOR[e.state];
        const since = now - e.flashAt;
        const alpha = e.flashAt && !REDUCED && since < COUNTRY_FLASH_MS
          ? Math.max(e.cur, 0.85 * (1 - since / COUNTRY_FLASH_MS)) : e.cur;
        if (alpha < 0.01 || !e.col) continue;
        if (e.poly) {
          if (!path) {
            g.save(); g.setTransform(DPR * k, 0, 0, DPR * k, DPR * T.x, DPR * T.y);
            path = d3.geoPath(proj, g);
          }
          g.globalAlpha = alpha; g.fillStyle = e.col;
          g.beginPath(); path(e.poly); g.fill();
        } else {
          // no outline in the atlas (Singapore): a soft disc around the office instead
          if (path) { g.restore(); path = null; }
          for (const c of e.cities) {
            const x = sx(c.p), y = sy(c.p), r = 34 * mk;
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const gr = g.createRadialGradient(x, y, 0, x, y, r);
            gr.addColorStop(0, e.col); gr.addColorStop(1, d3.color(e.col).copy({ opacity: 0 }).formatRgb());
            g.globalAlpha = Math.min(1, alpha * 1.4); g.fillStyle = gr;
            g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
          }
        }
      }
      if (path) g.restore();
      g.globalAlpha = 1;
    }

    // infection glow under infected agents
    for (const a of S.agents) {
      if (S.cat[a.id] !== "I") continue;
      const x = sx(a.p), y = sy(a.p), r = 26 * mk * (0.9 + 0.1 * Math.sin(now / 300 + a.id));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,30,30,0.55)"); gr.addColorStop(1, "rgba(255,30,30,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }

    // population specks
    for (const a of S.agents) {
      const cur = S.cat[a.id], prev = S.prevCat[a.id], since = now - S.catAt[a.id];
      for (const q of a.specks) {
        const c = since > q.delay * 1500 ? cur : prev;
        const s = q.size * mk * (c === "I" ? 1.35 : 1);
        g.fillStyle = c === "N" ? TH.normalSpeck : COLOR[c];
        g.fillRect(sx(q.p) - s / 2, sy(q.p) - s / 2, s, s);
      }
    }

    // transmission arcs
    S.arcs = S.arcs.filter((r) => now < r.t0 + r.dur + 700);
    for (const r of S.arcs) {
      if (now < r.t0) continue;
      const a = [sx(r.a.p), sy(r.a.p)], b = [sx(r.b.p), sy(r.b.p)];
      const t = Math.min(1, (now - r.t0) / r.dur), fade = t < 1 ? 1 : Math.max(0, 1 - (now - r.t0 - r.dur) / 700);
      const rgb = r.venue ? VENUE_CYAN : ROUTE_RED;
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (dist < 8) continue;
      const c = ctrl(a, b);
      g.save();
      if (r.venue) g.setLineDash([4, 4]);
      g.lineWidth = 1.2; g.strokeStyle = `rgba(${rgb}, ${0.22 * fade})`;
      g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(c[0], c[1], b[0], b[1]); g.stroke();
      g.setLineDash([]);
      // bright trail behind the head
      const steps = 14, t0 = Math.max(0, t - 0.35);
      g.lineCap = "round";
      for (let i = 0; i < steps; i++) {
        const u1 = t0 + ((t - t0) * i) / steps, u2 = t0 + ((t - t0) * (i + 1)) / steps;
        const p1 = qpt(a, c, b, u1), p2 = qpt(a, c, b, u2);
        g.strokeStyle = `rgba(${rgb}, ${((i + 1) / steps) * 0.95 * fade})`; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke();
      }
      if (t < 1 && dist > 50) { // plane at the head
        const h = qpt(a, c, b, t), h2 = qpt(a, c, b, Math.min(1, t + 0.01));
        g.translate(h[0], h[1]); g.rotate(Math.atan2(h2[1] - h[1], h2[0] - h[0]));
        g.fillStyle = "#fff";
        g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -5); g.lineTo(-2, 0); g.lineTo(-5, 5); g.closePath(); g.fill();
      }
      g.restore();
    }

    // ripples
    S.ripples = S.ripples.filter((r) => now < r.t0 + r.dur);
    for (const r of S.ripples) {
      const t = (now - r.t0) / r.dur, x = sx(r.a.p), y = sy(r.a.p);
      g.strokeStyle = r.color; g.globalAlpha = 1 - t; g.lineWidth = r.shield ? 3 : 2;
      g.beginPath(); g.arc(x, y, 5 + t * r.r * mk, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }

    // forecast risk halos (before a run, for the selected attack)
    if (S.showRisk && !S.running && riskInfo()) {
      for (const a of S.agents) {
        const rk = riskFor(a.id); if (rk == null) continue;
        const x = sx(a.p), y = sy(a.p), r = (7 + rk * 16) * Math.min(1.6, mk);
        const gr = g.createRadialGradient(x, y, 2, x, y, r);
        gr.addColorStop(0, `rgba(255,${Math.round(200 - 170 * rk)},30,${0.15 + 0.5 * rk})`);
        gr.addColorStop(1, "rgba(255,60,30,0)");
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    }

    // agent markers
    for (const a of S.agents) {
      const x = sx(a.p), y = sy(a.p), c = S.cat[a.id];
      const r = (a === S.hover ? 6.5 : 4.6) * Math.min(1.6, mk);
      if (a.venue) {
        g.save(); g.setLineDash([2, 2.5]); g.strokeStyle = `rgba(${VENUE_CYAN}, 0.85)`; g.lineWidth = 1.2;
        g.beginPath(); g.arc(x, y, r + 3.5, 0, Math.PI * 2); g.stroke(); g.restore();
      }
      g.fillStyle = COLOR[c]; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.lineWidth = 1.5; g.strokeStyle = c === "N" ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.95)"; g.stroke();
      if (S.caseFilter === a.id) { g.strokeStyle = "#5fd4ff"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, r + 6, 0, Math.PI * 2); g.stroke(); }
    }

    // patient-zero bubble
    const pz = S.byId.get(S.patientZero);
    if (pz) {
      const x = sx(pz.p), y = sy(pz.p) - 30 - 3 * Math.sin(now / 400);
      g.strokeStyle = "rgba(255,255,255,0.8)"; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(sx(pz.p), sy(pz.p) - 6); g.lineTo(x, y + 14); g.stroke();
      const gr = g.createRadialGradient(x - 4, y - 4, 2, x, y, 16);
      gr.addColorStop(0, "#ffb08a"); gr.addColorStop(1, S.virus.accent);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, 15, 0, Math.PI * 2); g.fill();
      g.lineWidth = 2; g.strokeStyle = "#fff"; g.stroke();
      g.font = "16px 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(S.virus.glyph, x, y + 1);
    }

    // speech bubbles over the agents whose link is talking right now
    if (window.SoundPhysics && window.SoundPhysics.on) {
      for (const t of window.SoundPhysics.active()) {
        if (t.g <= 0.06) continue;
        drawBubble(g, t.x1, t.y1, t.g, t.solo, now);
        drawBubble(g, t.x2, t.y2, t.g, t.solo, now + 260);
      }
    }

    requestAnimationFrame(frame);
  }

  // A speech bubble over an agent that is talking: three dots pulsing in sequence, sized
  // and brightened by how audible the link is, warmer and larger when the link is soloed.
  function drawBubble(g, x, y, gain, solo, now) {
    const s = (solo ? 1.5 : 1.15) * (0.85 + 0.4 * gain);
    const w = 24 * s, h = 13 * s;
    const bx = x - w / 2, by = y - 20 * s - h;
    g.save();
    g.globalAlpha = Math.max(0.45, Math.min(1, 0.55 + gain));
    g.fillStyle = solo ? "rgba(255,226,180,0.96)" : "rgba(240,248,255,0.92)";
    g.beginPath(); g.roundRect(bx, by, w, h, 4 * s); g.fill();
    g.beginPath(); g.moveTo(x - 3 * s, by + h - 0.5); g.lineTo(x, by + h + 4.5 * s);
    g.lineTo(x + 3 * s, by + h - 0.5); g.closePath(); g.fill();
    for (let i = 0; i < 3; i++) {
      const ph = ((now / 300) + i * 0.3) % 1;
      const r = (1.0 + 0.85 * Math.sin(ph * Math.PI)) * s;
      g.fillStyle = solo ? "rgba(96,62,18,0.92)" : "rgba(16,38,56,0.86)";
      g.beginPath(); g.arc(bx + w * (0.26 + i * 0.24), by + h / 2, r, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  // ------------------------------------------------------------------ pointer: hover, click, pick
  function agentAt(x, y) {
    let best = null, bd = 14;
    for (const a of S.agents) { const d = Math.hypot(sx(a.p) - x, sy(a.p) - y); if (d < bd) { bd = d; best = a; } }
    return best;
  }
  function countryUnder(x, y) {
    const ll = proj.invert([(x - T.x) / T.k, (y - T.y) / T.k]);
    return ll ? countryAt(ll[0], ll[1]) : null;
  }

  fx.addEventListener("pointermove", (e) => {
    S.pointer = [e.clientX, e.clientY];
    const a = agentAt(e.clientX, e.clientY);
    S.hover = a;
    if (S.picking) S.hoverCountry = countryUnder(e.clientX, e.clientY);
    const tip = $("tip");
    if (a) {
      const c = S.cat[a.id];
      tip.innerHTML = `<b>${esc(a.name)}</b> · ${esc(a.role)}<br>${esc(officeLabel(a.city))}, ${esc(a.city.land)}<br>
        <span class="st">${dot(c)} ${LABEL[c]}${S.vaccinated.has(a.id) && c !== "V" ? " · vaccinated" : ""}</span>${riskFor(a.id) != null ? `<br>Forecast risk from ${esc(S.virus.name)}: <b>${pct(riskFor(a.id))}</b>` : ""}${a.venue ? "<br><span class='muted'>In the group chat (super-spreader venue)</span>" : ""}`;
      tip.classList.remove("hidden");
      placeNear(tip, e.clientX, e.clientY);
    } else if (S.picking && S.hoverCountry) {
      const has = S.agents.some((x) => x.city.country === S.hoverCountry);
      tip.innerHTML = `<b>${esc(S.hoverCountry.properties.name)}</b><br>${has ? "Click to start the outbreak here" : "<span class='muted'>No agents live here</span>"}`;
      tip.classList.remove("hidden"); placeNear(tip, e.clientX, e.clientY);
    } else tip.classList.add("hidden");
    fx.style.cursor = a ? "pointer" : "";
  });
  fx.addEventListener("pointerleave", () => { $("tip").classList.add("hidden"); S.hover = null; });

  let downAt = null;
  fx.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
  fx.addEventListener("click", (e) => {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // it was a drag
    const a = agentAt(e.clientX, e.clientY);
    if (S.picking) {
      let target = a;
      if (!target) {
        const c = countryUnder(e.clientX, e.clientY);
        const here = S.agents.filter((x) => x.city.country === c);
        if (!c) return;
        if (!here.length) { toast(`No agents live in ${c.properties.name}. Pick a glowing country.`, true); return; }
        target = here.find((x) => !x.venue) || here[0];
      }
      startRun(target.id);
      return;
    }
    // with the soundscape on, a click on a contact link solos that conversation
    if (!a && window.SoundPhysics && window.SoundPhysics.on) {
      const key = window.SoundPhysics.pick(e.clientX, e.clientY);
      if (key) { window.SoundPhysics.solo(key); drawBase(); toast(`Listening to link ${key}. Click empty map or press Esc to release.`); return; }
      if (window.SoundPhysics.soloKey) { window.SoundPhysics.release(); drawBase(); }
    }
    if (a) { showCard(a, e.clientX, e.clientY); filterCases(a.id); }
    else hideCard();
  });

  function placeNear(el, x, y) {
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(innerWidth - w - 8, x + 14) + "px";
    el.style.top = Math.min(innerHeight - h - 8, Math.max(8, y + 14)) + "px";
  }

  function showCard(a, x, y) {
    const c = S.cat[a.id], m = S.lastMsg[a.id];
    const card = $("card");
    card.innerHTML = `<button class="icon-btn close" aria-label="Close">✕</button>
      <div class="ah">${dot(c)}<span class="an">${esc(a.name)}</span></div>
      <div class="ar">${esc(a.role)} · ${esc(officeLabel(a.city))}, ${esc(a.city.land)}</div>
      <div class="chips">
        <span class="chip">${dot(c)} ${LABEL[c]}</span>
        ${S.vaccinated.has(a.id) ? `<span class="chip">${dot("V")} vaccinated</span>` : ""}
        ${a.venue ? `<span class="chip">💬 group chat</span>` : ""}
        <span class="chip">${a.degree} contacts</span>
        ${riskFor(a.id) != null ? `<span class="chip">🎯 ${pct(riskFor(a.id))} forecast risk</span>` : ""}
        ${S.patientZero === a.id ? `<span class="chip">☣ patient zero</span>` : ""}
      </div>
      ${m ? `<div class="muted" style="font-size:12px;margin-bottom:4px">Day ${m.tick} · ${m.kind === "infected" ? "message that carried it on" : "reply that did not spread it"}${m.from != null ? ` · after ${esc(nameOf(m.from))}'s message` : ""}</div>
      <div class="msg">${esc(m.text)}</div>` : `<div class="muted">No messages yet.</div>`}`;
    card.classList.remove("hidden");
    card.querySelector(".close").onclick = hideCard;
    placeNear(card, x, y);
  }
  function hideCard() { $("card").classList.add("hidden"); }

  // ------------------------------------------------------------------ runs
  function params(patientZero) {
    return {
      n: +$("n").value, seed: +$("seed").value, ticks: +$("ticks").value,
      policy: S.policy, k: S.policy === "none" ? 0 : S.k,
      risk_order: S.policy === "risk" ? riskOrder() : null,
      who_every: $("who-on").checked ? 4 : 0, use_who_vaccine: $("usewho").checked,
      patient_zero: patientZero, pace: 0, label: S.virus.id,
      ...S.virus.sim,
    };
  }

  function enterPick() {
    hideCard(); $("intro").classList.add("hidden"); $("end").classList.add("hidden");
    stopRun(true);
    resetEpidemic();
    S.picking = true; document.body.classList.add("picking"); $("pick-hint").classList.remove("hidden");
    zoomHome();
    $("news-text").textContent = `${S.virus.name} is ready. Choose where it starts.`;
  }
  function exitPick() {
    $("tip").classList.add("hidden");
    S.picking = false; S.hoverCountry = null; document.body.classList.remove("picking"); $("pick-hint").classList.add("hidden");
  }

  function startRun(patientZero) {
    exitPick();
    stopRun(true);
    resetEpidemic();
    S.running = true; setRunningUI(true);
    if (S.speed === 0) setSpeed(S.lastSpeed || 1);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/run`);
    S.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(params(patientZero)));
    ws.onmessage = (m) => { if (S.ws === ws) enqueue(JSON.parse(m.data)); };
    ws.onerror = () => { if (S.ws === ws) { toast("Lost the connection to the ChonkVid server. Is `python -m chonkvid serve` running?"); stopRun(); } };
    ws.onclose = () => { if (S.ws === ws) S.ws = null; };
    headline(`${S.virus.name} released. Watching for the first transmissions…`, true);
  }

  function stopRun(silent) {
    stopBriefing();
    playingReplay = false;
    briefingReplay = null;
    renderRisk();
    if (S.ws) { const w = S.ws; S.ws = null; try { w.close(); } catch (e) { /* already closed */ } }
    clearTimeout(S.timer); S.timer = null; S.queue = [];
    S.running = false; setRunningUI(false);
    if (!silent) headline("Simulation stopped");
  }

  function setRunningUI(on) {
    const go = $("go");
    go.textContent = on ? "■ Stop outbreak" : "☣ Release outbreak";
    go.classList.toggle("primary", !on);
    $("virus").disabled = on;
  }

  function showEnd(ev) {
    S.running = false; S.runEnded = true; setRunningUI(false);
    const s = ev.summary, rate = s.attack_rate;
    if (playingReplay) {
      briefingReplay = ev;
      renderRisk();
    }
    $("end-kicker").textContent = `${S.virus.name.toUpperCase()} · ${policyName(s.policy).toUpperCase()}`;
    $("end-title").textContent = rate >= 0.6 ? "Global pandemic" : rate >= 0.25 ? "Major outbreak" : rate > 0 ? "Outbreak contained" : "It never took off";
    $("end-title").style.color = rate >= 0.6 ? "#ff4a4a" : rate >= 0.25 ? "#ff9a3d" : "#4fe07a";
    $("e-attack").textContent = Math.round(rate * 100) + "%";
    $("e-peak").textContent = `${s.peak_infectious}`;
    $("e-peak-k").textContent = `peak infected (day ${s.peak_tick})`;
    $("e-held").textContent = s.k ? `${s.k - s.vaccinated_infected}/${s.k}` : "–";
    $("e-r").textContent = Number(s.observed_R || 0).toFixed(2);
    const src = ev.source === "mock"
      ? "MOCK run: a scripted stand-in model, not Mistral. Use these numbers for rehearsal only."
      : `Live run on ${(S.status && S.status.models.agent) || "Mistral"}. Every infection after patient zero is a real model reply that carried the payload on.`;
    const vnote = S.virus.live ? "" : ` ${S.virus.name} used its own harmless test payload; infection means an agent's reply carried that payload on.`;
    $("end-note").textContent = `${src}${vnote} ${ev.usage ? `${ev.usage.chat_calls} model calls.` : ""}`;
    renderForecastVerdict();
    headline(`Outbreak over: ${Math.round(rate * 100)}% of agents infected`, true);
    setTimeout(() => { if (S.runEnded) $("end").classList.remove("hidden"); }, 1400 / Math.max(1, S.speed));
  }

  // "Timestral forecast called 45% on day 2 and 34% on day 5; actual 90% by day 14."
  function renderForecastVerdict() {
    const el = $("end-forecast");
    const checks = [...S.fcChecks].sort((a, b) => a.made_at - b.made_at);
    if (!checks.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const pctOf = (x) => `${Math.round(x * 100)}%`;
    const calls = checks.map((c) => `<b>${pctOf(c.pred_attack_rate)}</b> on day ${c.made_at}`);
    const said = calls.length > 1 ? `${calls.slice(0, -1).join(", ")} and ${calls[calls.length - 1]}` : calls[0];
    const c0 = checks[checks.length - 1];
    const detail = checks.map((c) => `day ${c.made_at}: off by ${Number(c.mae_agents).toFixed(1)} agents on average, ` +
      `real curve inside the 80% band ${pctOf(c.coverage_80)} of the time`).join(" · ");
    el.innerHTML = `Timestral forecast called ${said}; actual <b>${pctOf(c0.actual_attack_rate)}</b> by day ${c0.final_tick}.` +
      `<small>${esc(detail)}. Model ${esc(c0.model)}, Mistral's time-series forecaster, run locally.</small>`;
    el.classList.remove("hidden");
  }

  async function loadRuns(select) {
    try {
      const runs = await (await fetch("/api/runs")).json();
      const s = $("runs"); s.innerHTML = `<option value="">Recorded runs (${runs.length})…</option>`;
      for (const r of runs) { const o = document.createElement("option"); o.value = r.id; o.textContent = r.id.replace(".jsonl", ""); s.appendChild(o); }
      if (select) s.value = select;
    } catch (e) { /* server offline: leave the list empty */ }
  }
  async function replay() {
    const id = $("runs").value; if (!id) { toast("Choose a recorded run first.", true); return; }
    exitPick(); stopRun(true);
    try {
      const events = await (await fetch("/api/runs/" + encodeURIComponent(id))).json();
      $("intro").classList.add("hidden"); $("end").classList.add("hidden"); closeIntel();
      playingReplay = true;
      S.running = true; setRunningUI(true);
      if (S.speed === 0) setSpeed(S.lastSpeed || 1);
      for (const ev of events) enqueue(ev);
    } catch (e) { toast("Could not load that run."); }
  }

  // ------------------------------------------------------------------ virus selection
  // Placeholder for when real datasets arrive: fetch v.dataset and return it.
  async function loadVirusDataset(v) {
    if (!v.dataset) return null;
    if (typeof v.dataset === "object") return v.dataset;
    try { return await (await fetch(v.dataset)).json(); } catch (e) { return null; }
  }

  function fillVirusSelect(sel) {
    const live = VIRUSES.filter((v) => v.live), real = VIRUSES.filter((v) => !v.live);
    sel.innerHTML =
      `<optgroup label="ChonkVid's own chain letter">${live.map((v) => `<option value="${v.id}">${v.glyph}  ${esc(v.name)}</option>`).join("")}</optgroup>` +
      `<optgroup label="Known prompt injections (harmless test payloads)">${real.map((v) => `<option value="${v.id}">${v.glyph}  ${esc(v.name)}</option>`).join("")}</optgroup>`;
  }

  // Measured spread per contact for each catalogue attack (python -m chonkvid attacks).
  async function loadAttackStats() {
    try {
      const d = await (await fetch("/api/attacks")).json();
      S.attackStats = Object.fromEntries(d.attacks.map((a) => [a.id, a]));
    } catch (e) { S.attackStats = {}; }
    if (S.virus) selectVirus(S.virus.id, true);
  }
  const CHANNEL_NAME = { message: "a colleague's message", email: "an email from the inbox",
                         hidden: "invisible Unicode characters", image: "an image (vision model)" };
  function attackTags(v) {
    if (v.live) return `<span class="tag live">● measured live on Mistral</span>`;
    const a = (S.attackStats || {})[v.id];
    if (!a) return `<span class="tag">real payload</span>`;
    const m = a.measured;
    const how = `<span class="tag">arrives as ${esc(CHANNEL_NAME[a.channel] || a.channel)}</span>`;
    if (!m) return `<span class="tag pending">not measured yet</span>${how}`;
    const cls = m.source === "live" ? "live" : "pending";
    return `<span class="tag ${cls}">● spread ${Math.round(m.p * 100)}% per contact (${m.k}/${m.n}, ${m.source === "live" ? "live" : "MOCK"})</span>`
      + `<span class="tag">${esc(a.effect)} ${Math.round(m.effect_rate * 100)}%</span>${how}`;
  }

  function selectVirus(id, quiet) {
    const v = VIRUSES.find((x) => x.id === id) || VIRUSES[0];
    if (v !== S.virus) {
      stopBriefing();
      briefingReplay = null;
    }
    S.virus = v;
    $("virus").value = v.id; $("virus-intro").value = v.id;
    $("dz-glyph").textContent = v.glyph;
    $("dz-meta").textContent = v.kind;
    const card = $("vcard");
    card.style.setProperty("--accent", v.accent);
    card.innerHTML = `<div class="vh"><span class="vg">${v.glyph}</span><div><div class="vn">${esc(v.name)}</div><div class="vk">${esc(v.kind)}</div></div></div>
      <p>${esc(v.blurb)}</p>
      <div class="facts">
        <div><div class="k">Technique</div><div class="v">${esc(v.facts.technique)}</div></div>
        <div><div class="k">Hides in</div><div class="v">${esc(v.facts.hides)}</div></div>
        <div><div class="k">Goal</div><div class="v">${esc(v.facts.goal)}</div></div>
        <div><div class="k">Spreads by</div><div class="v">${esc(v.facts.spread)}</div></div>
      </div>
      <div class="tagline">${attackTags(v)}</div>`;
    document.documentElement.style.setProperty("--danger", v.accent);
    if (!quiet && !S.running) $("news-text").textContent = `${v.name} selected. ${v.kind}.`;
    loadVirusDataset(v); // no-op until datasets are added
    renderRisk();
  }

  // ------------------------------------------------------------------ UI wiring
  function toast(msg, info) {
    const t = $("toast"); t.textContent = msg; t.classList.toggle("info", !!info); t.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), info ? 2600 : 6000);
  }
  function openIntel() { $("intel").classList.add("open"); $("intel").setAttribute("aria-hidden", "false"); setTimeout(drawCurve, 300); }
  function closeIntel() { $("intel").classList.remove("open"); $("intel").setAttribute("aria-hidden", "true"); }

  function buildLegends() {
    $("legend").innerHTML = STATES.map((s) => `<li data-k="${s.key}" title="${esc(s.def)}"><i class="swatch" style="background:${s.color}"></i><span class="lab">${s.label}</span><span class="num">0</span></li>`).join("");
    $("mini-legend").innerHTML = STATES.map((s) => `<li><i class="swatch" style="background:${s.color}"></i>${s.label}</li>`).join("");
    $("defs").innerHTML = STATES.map((s) => `<li><i class="swatch" style="background:${s.color}"></i><span><b>${s.label}</b>: ${esc(s.def)}</span></li>`).join("") +
      `<li><i class="swatch" style="background:transparent;box-shadow:0 0 0 1.5px rgb(${VENUE_CYAN})"></i><span><b>Dashed cyan ring</b>: a member of the group chat, where one message reaches everyone in it.</span></li>` +
      `<li><i class="swatch" style="background:linear-gradient(90deg, ${COLOR.I}, ${COLOR.E}, ${COLOR.R})"></i><span><b>Coloured countries</b>: a country with agents takes the colour of its most serious state (infected, then exposed, recovered, susceptible, vaccinated), and flashes when the attack first lands there.</span></li>`;
  }

  function runMapCommand(transcript) {
    const normalize = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const words = normalize(transcript);
    const cities = (S.cities || []).filter((city) => city.agents.length);
    let office = cities.find((city) => words.includes(normalize(city.name)));
    const tab = (name) => {
      openIntel();
      document.querySelector(`.tab[data-tab="${name}"]`).click();
    };
    if (/whole map|world view|zoom out|reset.*map|fit map/.test(words)) {
      zoomHome();
      closeIntel();
      $("briefing-office").value = "";
      renderRisk();
      return "Showing the whole fleet.";
    }
    if (/highest|most at risk|riskiest/.test(words)) {
      if (!riskInfo() || !cities.length) return "There is no risk forecast for this selection yet.";
      const scores = cities.map(c => Math.round(100 * c.agents.reduce((sum, a) => sum + (riskFor(a.id) ?? 0), 0) / c.agents.length));
      const highest = Math.max(...scores);
      const leaders = cities.filter((_, i) => scores[i] === highest);
      if (leaders.length > 1) return `${leaders.map(c => c.name).join(", ")} share the highest forecast. Which office would you like to see?`;
      office = leaders[0];
    }
    if (office || /compar|risk|forecast/.test(words)) {
      if (office) zoomTo(office.lon, office.lat, 3);
      if (!S.showRisk) $("risk-toggle").click();
      tab("risk");
      $("briefing-question").value = "outlook";
      if (office) $("briefing-office").value = officeLabel(office);
      renderRisk();
      if (office && !riskInfo()) return `Showing ${office.name}. No forecast is available yet.`;
      return $("briefing-transcript").textContent;
    }
    const pause = /\bpause\b/.test(words), resume = /\b(resume|continue)\b/.test(words);
    const cases = /\bcases\b/.test(words);
    if (pause || resume) setSpeed(pause ? 0 : S.lastSpeed || 1);
    if (cases) tab("cases");
    if (pause || resume || cases) return [pause ? "Playback paused." : resume ? "Playback resumed." : "", cases ? "Showing the cases panel." : ""].filter(Boolean).join(" ");
    return "Try show Paris, compare it with the fleet, pause and show cases, or zoom out.";
  }

  function wireMapMicrophone() {
    const button = $("talk-map");
    const idleLabel = button.textContent;
    let recorder;
    let held = false;
    let discard = false;
    async function record(fromKeyboard) {
      if (recorder?.state === "recording") { recorder.stop(); return; }
      stopBriefing();
      if (!S.status) { toast("Voice service status is unavailable. Reload the map and try again."); return; }
      if (!S.status.key) { toast("This server has no Mistral key. Open the voice-enabled preview."); return; }
      const mime = ["audio/webm", "audio/mp4", "audio/ogg"].find(type => window.MediaRecorder?.isTypeSupported(type));
      if (!mime || !navigator.mediaDevices?.getUserMedia) { toast("This browser cannot record audio. Open the map in Chrome or Edge."); return; }
      button.disabled = true;
      let stream;
      const release = () => {
        stream?.getTracks().forEach(track => track.stop());
        stream = null;
      };
      const reset = () => { release(); recorder = null; button.disabled = false; button.textContent = idleLabel; };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (fromKeyboard && !held) { reset(); return; }
        discard = false;
        recorder = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        const timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, 12000);
        recorder.onstop = async () => {
          clearTimeout(timer);
          release();
          if (discard) { reset(); return; }
          button.disabled = true;
          button.textContent = "Transcribing…";
          try {
            const response = await fetch("/api/map-transcript", { method: "POST", body: new Blob(chunks, { type: mime }) });
            if (!response.ok) throw new Error();
            const { text } = await response.json();
            if (!text?.trim()) { toast("No speech detected. Try again."); return; }
            const answer = runMapCommand(text);
            toast(`Heard “${text}” — ${answer}`, true);
            stopBriefing();
            await listenToBriefing(answer);
          } catch { toast("Could not process the recording. Try again."); }
          finally { reset(); }
        };
        recorder.start();
        button.disabled = false;
        button.textContent = fromKeyboard ? "Release V to send" : "Stop and send";
      } catch { reset(); toast("Could not start the microphone. Check the browser’s microphone permission."); }
    }
    button.onclick = () => record(false);
    document.addEventListener("keydown", e => {
      if (e.key.toLowerCase() !== "v" || held || e.repeat || e.isComposing ||
          e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || button.disabled || recorder ||
          e.target.isContentEditable || e.target.closest?.("input, select, textarea")) return;
      e.preventDefault();
      held = true;
      record(true);
    });
    function releaseKey(cancel) {
      if (!held) return;
      held = false;
      if (recorder?.state === "recording") {
        discard = cancel;
        recorder.stop();
      }
    }
    document.addEventListener("keyup", e => {
      if (e.key.toLowerCase() === "v") releaseKey(false);
    });
    window.addEventListener("blur", () => releaseKey(true));
  }

  function wire() {
    wireMapMicrophone();
    $("briefing-listen").onclick = listenToBriefing;
    $("briefing-question").onchange = () => { stopBriefing(); renderRisk(); };
    $("runs").addEventListener("change", () => {
      stopBriefing();
      briefingReplay = null;
      renderRisk();
    });
    fillVirusSelect($("virus")); fillVirusSelect($("virus-intro"));
    $("virus").onchange = (e) => selectVirus(e.target.value);
    $("virus-intro").onchange = (e) => selectVirus(e.target.value);
    for (const b of $("policy").querySelectorAll("button")) {
      b.onclick = () => {
        S.policy = b.dataset.policy;
        for (const x of $("policy").querySelectorAll("button")) { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-checked", on); }
        renderCounts(lastCounts.N !== undefined ? lastCounts : { N: 0, S: 0, E: 0, I: 0, V: 0, R: 0 });
      };
    }
    $("k").oninput = (e) => { S.k = +e.target.value; $("k-val").textContent = S.k; refreshCats(true); };
    $("intro-go").onclick = enterPick;
    $("intro-explore").onclick = () => $("intro").classList.add("hidden");
    $("go").onclick = () => (S.running ? stopRun() : enterPick());
    $("pick-cancel").onclick = () => { exitPick(); $("news-text").textContent = "Outbreak cancelled."; };
    $("pick-random").onclick = () => startRun(null);
    $("end-again").onclick = enterPick;
    $("end-change").onclick = () => { $("end").classList.add("hidden"); $("intro").classList.remove("hidden"); };
    $("end-view").onclick = () => $("end").classList.add("hidden");
    $("open-intel").onclick = () => ($("intel").classList.contains("open") ? closeIntel() : openIntel());
    $("risk-toggle").onclick = () => {
      S.showRisk = !S.showRisk;
      $("risk-toggle").classList.toggle("on", S.showRisk);
      if (S.showRisk) { openIntel(); document.querySelector('.tab[data-tab="risk"]').click(); }
    };
    const openCurve = () => { openIntel(); document.querySelector('.tab[data-tab="curve"]').click(); };
    $("mini-curve").onclick = openCurve;
    $("mini-curve").onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openCurve(); }
    };
    $("close-intel").onclick = closeIntel;
    $("zoom-reset").onclick = () => zoomHome();
    // zoom about the pointer when there is one, so the buttons feel like the touchpad
    const zoomStep = (factor) => () => {
      const p = S.pointer || [W / 2, H / 2];
      d3.select(fx).transition().duration(200)
        .call(zoom.scaleBy, factor, [Math.max(0, Math.min(W, p[0])), Math.max(0, Math.min(H, p[1]))]);
    };
    const zin = $("zoom-in"), zout = $("zoom-out");
    if (zin) zin.onclick = zoomStep(1.6);
    if (zout) zout.onclick = zoomStep(1 / 1.6);

    const sndBtn = $("sound-toggle");
    const paintSound = (live) => {
      if (!sndBtn) return;
      sndBtn.classList.toggle("on", !!live);
      sndBtn.textContent = live ? "🔊 Sound on" : "🔇 Sound off";
      sndBtn.title = live
        ? "Click a contact link to solo that conversation, again to release. Click here to mute."
        : "Turn the world's chatter on (Voxtral)";
      sndBtn.setAttribute("aria-pressed", live ? "true" : "false");
    };
    if (sndBtn && window.SoundPhysics) {
      paintSound(false);
      sndBtn.onclick = async () => {
        if (window.SoundPhysics.on) {
          window.SoundPhysics.disable();
          paintSound(false);
          drawBase();
          return;
        }
        const ok = await window.SoundPhysics.enable();
        paintSound(!!ok);
        if (ok) { loadChatter(); syncCamera(); drawBase(); }
      };
    }
    addEventListener("keydown", (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "Escape" && window.SoundPhysics && window.SoundPhysics.soloKey) {
        window.SoundPhysics.release(); drawBase();
      }
      if (e.key === "+" || e.key === "=") { zoomStep(1.6)(); }
      if (e.key === "-" || e.key === "_") { zoomStep(1 / 1.6)(); }
    });
    $("news-more").onclick = () => { $("headline-list").innerHTML = $("headlines").innerHTML || "<div class='muted'>No headlines yet.</div>"; $("headline-list").classList.toggle("hidden"); };
    $("replay").onclick = replay;
    for (const b of document.querySelectorAll(".speed button")) b.onclick = () => setSpeed(+b.dataset.speed);
    for (const t of document.querySelectorAll(".tab")) {
      t.onclick = () => {
        for (const x of document.querySelectorAll(".tab")) x.classList.toggle("on", x === t);
        for (const p of document.querySelectorAll(".tabpane")) p.classList.toggle("on", p.dataset.pane === t.dataset.tab);
        if (t.dataset.tab === "curve") drawCurve();
      };
    }
    for (const id of ["n", "seed"]) $(id).onchange = () => { if (!S.running) loadWorld(); };
    $("ticks").onchange = drawCurve;
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === " ") { e.preventDefault(); setSpeed(S.speed ? 0 : S.lastSpeed || 1); }
      else if (e.key === "1") setSpeed(1); else if (e.key === "2") setSpeed(2); else if (e.key === "3") setSpeed(4);
      else if (e.key === "Escape") {
        if (S.picking) exitPick();
        hideCard(); closeIntel(); $("headline-list").classList.add("hidden");
      }
    });
    addEventListener("resize", () => { resize(); drawCurve(); syncCamera(); });
    // Light/dark theme (theme.js): buttons in Setup, and a re-skin on every change.
    const effectiveTheme = () => (window.ChonkTheme ? ChonkTheme.effective() : "dark");
    const markTheme = () => {
      const pref = window.ChonkTheme ? ChonkTheme.current() : "dark";
      for (const b of document.querySelectorAll("#theme-seg button")) {
        const on = b.dataset.themePref === pref;
        b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
      }
      // Quick toggle on the map: shows the theme a click switches to.
      const dark = effectiveTheme() === "dark", btn = $("theme-toggle");
      if (btn) {
        btn.textContent = dark ? "☀ Light" : "☾ Dark";
        btn.title = `Switch to ${dark ? "light" : "dark"} mode`;
        btn.setAttribute("aria-label", btn.title);
      }
    };
    for (const b of document.querySelectorAll("#theme-seg button")) b.onclick = () => window.ChonkTheme && ChonkTheme.set(b.dataset.themePref);
    $("theme-toggle").onclick = () => window.ChonkTheme && ChonkTheme.set(effectiveTheme() === "dark" ? "light" : "dark");
    addEventListener("chonkvid-theme", () => { markTheme(); readTheme(); drawBase(); drawCurve(); });
    markTheme();
  }

  async function loadWorld() {
    try {
      const w = await (await fetch(`/api/world?n=${+$("n").value}&seed=${+$("seed").value}`)).json();
      layoutWorld(w);
      loadRisk();
    } catch (e) { toast("Could not reach the ChonkVid server. Start it with `python -m chonkvid serve`."); }
  }

  async function init() {
    buildLegends();
    wire();
    selectVirus(VIRUSES[0].id, true);
    const topo = await (await fetch("/static/world/vendor/countries-110m.json")).json();
    const all = topojson.feature(topo, topo.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
    S.countries = all;
    for (const c of all) c.centroid = d3.geoCentroid(c);
    S.land = { type: "FeatureCollection", features: all };
    S.borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
    resize();
    try {
      S.status = await (await fetch("/api/status")).json();
      const m = $("mode");
      m.textContent = S.status.mode === "live" ? "LIVE" : "MOCK";
      m.className = "mode " + S.status.mode;
      m.title = S.status.mode === "live" ? `Live on ${S.status.models.agent}` : "Mock mode: a scripted stand-in model. Add MISTRAL_API_KEY for live runs.";
      $("shared-auth").hidden = !S.status.database;
      $("access-token").onchange = () => loadRisk();
    } catch (e) { $("mode").textContent = "OFFLINE"; }
    await loadWorld();
    loadRuns();
    loadAttackStats();
    $("loading").classList.add("done");
    setTimeout(() => $("loading").classList.add("hidden"), 500);
    requestAnimationFrame(frame);
  }
  init().catch((e) => { console.error(e); $("loading").innerHTML = "Could not load the map: " + esc(e.message); });
})();
