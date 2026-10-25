/* Mémoria — révision de flashcards hors ligne avec répétition espacée */
(() => {
  'use strict';

  const STORE_KEY = 'memoria.v1';
  // Délai (en jours) avant le prochain retour d'une carte réussie, selon le nombre de réussites d'affilée.
  const CORRECT_INTERVALS = [2, 4, 8];
  const MASTERY_STREAK = 3;
  const MAX_RETRIES_IN_SESSION = 2;
  const LEVELS = { new: 'Nouvelle', hard: 'Difficile', medium: 'Moyenne', easy: 'Facile' };
  const DURATIONS = [5, 10, 15, 20, 30, 45, 60, 0]; // 0 = sans limite

  // ---------- Utilitaires ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  const plain = s => String(s ?? '').replace(/\*\*/g, '');
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const chapterNum = c => { const m = /^(\d+)/.exec(c); return m ? Number(m[1]) : 999; };
  const groupOf = m => m.split(' ')[0];
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const fmtDate = t => new Date(t).toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ---------- Données enregistrées ----------
  function defaultState() {
    return {
      v: 1,
      progress: {},   // id -> { reviews, correct, partial, wrong, streak, step, due, last, hist, updatedAt }
      custom: [],     // cartes ajoutées dans l'app
      edits: {},      // id -> champs modifiés d'une carte d'origine
      hidden: {},     // id -> date de masquage
      sessions: [],   // historique des sessions
      settings: {
        newPerSession: 10,
        examDate: '2028-04-03',
        theme: 'auto',
        duration: 15,
        levels: ['new', 'hard', 'medium', 'easy'],
        selection: null
      }
    };
  }

  function load() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return Object.assign(base, s, { settings: Object.assign(base.settings, s.settings || {}) });
      }
    } catch (e) { /* stockage indisponible : on repart d'un état vide */ }
    return base;
  }

  let state = load();

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Impossible d’enregistrer sur cet appareil.'); }
  }

  // Fusionne une autre sauvegarde (import, et plus tard synchronisation) : la version la plus récente gagne.
  function mergeState(other) {
    const newer = (a, b) => (!a || (b && (b.updatedAt || 0) > (a.updatedAt || 0)) ? b : a);
    for (const [id, p] of Object.entries(other.progress || {})) state.progress[id] = newer(state.progress[id], p);
    const custom = new Map(state.custom.map(c => [c.id, c]));
    for (const c of other.custom || []) custom.set(c.id, newer(custom.get(c.id), c));
    state.custom = Array.from(custom.values());
    for (const [id, e] of Object.entries(other.edits || {})) state.edits[id] = newer(state.edits[id], e);
    Object.assign(state.hidden, other.hidden || {});
    const seen = new Set(state.sessions.map(s => s.at));
    for (const s of other.sessions || []) if (!seen.has(s.at)) state.sessions.push(s);
    state.sessions.sort((a, b) => a.at - b.at);
  }

  // ---------- Cartes ----------
  let CARDS = [];
  let BY_ID = new Map();

  function refreshCards() {
    const base = (window.MEMORIA_CARDS || []).map(c => (state.edits[c.id] ? Object.assign({}, c, state.edits[c.id], { edited: true }) : c));
    CARDS = base.concat(state.custom.map(c => Object.assign({ custom: true }, c))).filter(c => !state.hidden[c.id]);
    CARDS.sort((a, b) => a.m.localeCompare(b.m, 'fr') || chapterNum(a.c) - chapterNum(b.c) || a.c.localeCompare(b.c, 'fr') || idNum(a.id) - idNum(b.id));
    BY_ID = new Map(CARDS.map(c => [c.id, c]));
  }
  function idNum(id) { const m = /(\d+)$/.exec(id); return m ? Number(m[1]) : 0; }

  // Arborescence groupe > matière > chapitre
  function tree() {
    const groups = new Map();
    for (const c of CARDS) {
      const g = groupOf(c.m);
      if (!groups.has(g)) groups.set(g, new Map());
      const subjects = groups.get(g);
      if (!subjects.has(c.m)) subjects.set(c.m, new Map());
      const chapters = subjects.get(c.m);
      if (!chapters.has(c.c)) chapters.set(c.c, []);
      chapters.get(c.c).push(c.id);
    }
    return groups;
  }
  const chapterKey = (m, c) => `${m}|${c}`;

  // ---------- Progression et répétition espacée ----------
  const P = id => state.progress[id];
  const isNew = id => !P(id) || !P(id).reviews;
  const isDue = (id, t = today()) => !isNew(id) && P(id).due <= t;
  const isMastered = id => !!P(id) && P(id).streak >= MASTERY_STREAK;

  function level(id) {
    const p = P(id);
    if (!p || !p.reviews) return 'new';
    const errorRate = (p.wrong + 0.5 * p.partial) / p.reviews;
    if (p.last === 'wrong' || errorRate >= 0.5) return 'hard';
    if (p.streak >= 2 && errorRate < 0.25) return 'easy';
    return 'medium';
  }

  function grade(id, g) {
    const t = today();
    const p = state.progress[id] || { reviews: 0, correct: 0, partial: 0, wrong: 0, streak: 0, step: 0, due: t, hist: [] };
    p.reviews++;
    p[g]++;
    p.last = g;
    if (g === 'correct') {
      p.streak++;
      p.due = addDays(t, CORRECT_INTERVALS[Math.min(p.step, CORRECT_INTERVALS.length - 1)]);
      p.step++;
    } else {
      // Incorrecte ou incomplète : la carte revient le lendemain et son cycle recommence.
      p.streak = 0;
      p.step = 0;
      p.due = addDays(t, 1);
    }
    p.hist = (p.hist || []).concat({ t: Date.now(), g }).slice(-20);
    p.updatedAt = Date.now();
    state.progress[id] = p;
    save();
  }

  function dueLabel(id) {
    const p = P(id);
    if (!p || !p.reviews) return 'jamais révisée';
    const days = Math.round((p.due - today()) / 86400000);
    if (days <= 0) return 'à revoir aujourd’hui';
    if (days === 1) return 'à revoir demain';
    return `à revoir dans ${days} jours`;
  }

  function countDue(ids) { const t = today(); return ids.filter(id => isDue(id, t)).length; }

  function dayStreak() {
    const days = new Set(state.sessions.map(s => { const d = new Date(s.at); d.setHours(0, 0, 0, 0); return d.getTime(); }));
    let t = today();
    if (!days.has(t)) t = addDays(t, -1);
    let n = 0;
    while (days.has(t)) { n++; t = addDays(t, -1); }
    return n;
  }

  // ---------- Thème ----------
  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }

  // ---------- Routage ----------
  const view = () => $('#view');
  let session = null;

  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  function render() {
    const [, route = 'home', arg] = (location.hash || '#/home').split('/');
    if (route !== 'study' && session && !session.finished) endTimer();
    document.body.classList.toggle('studying', route === 'study');
    $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === route || (route === 'card' && a.dataset.tab === 'cards') || (route === 'setup' && a.dataset.tab === 'home')));
    const screens = { home: renderHome, setup: renderSetup, study: renderStudy, summary: renderSummary, progress: renderProgress, cards: renderCards, card: renderCard, edit: renderEdit, settings: renderSettings };
    (screens[route] || renderHome)(arg ? decodeURIComponent(arg) : undefined);
    window.scrollTo(0, 0);
  }

  // ---------- Accueil ----------
  function renderHome() {
    const ids = CARDS.map(c => c.id);
    const due = countDue(ids);
    const fresh = ids.filter(isNew).length;
    const mastered = ids.filter(isMastered).length;
    const exam = new Date(state.settings.examDate + 'T00:00:00');
    const daysLeft = Math.ceil((exam.getTime() - today()) / 86400000);
    const hour = new Date().getHours();
    const hello = hour < 5 || hour >= 18 ? 'Bonsoir' : 'Bonjour';

    const subjects = [];
    for (const [, subs] of tree()) for (const [m, chapters] of subs) {
      const sids = Array.from(chapters.values()).flat();
      subjects.push({ m, total: sids.length, mastered: sids.filter(isMastered).length, due: countDue(sids) });
    }

    view().innerHTML = `
      <p class="muted">${hello}</p>
      <h1>Mémoria</h1>
      <section class="hero">
        <div class="row between">
          <div>
            <div class="big-number">${due}</div>
            <p class="muted">${due > 1 ? 'cartes à revoir' : 'carte à revoir'} aujourd’hui</p>
          </div>
          ${daysLeft > 0 ? `<span class="chip accent">J-${daysLeft} avant l’examen</span>` : ''}
        </div>
        <p class="small muted" style="margin-top:10px">${plural(fresh, 'nouvelle carte', 'nouvelles cartes')} à découvrir.</p>
        <a class="btn primary block" style="margin-top:16px" href="#/setup">Réviser</a>
      </section>
      <div class="stats-grid">
        <div class="stat"><b>${mastered}</b><span>maîtrisées</span></div>
        <div class="stat"><b>${CARDS.length}</b><span>cartes</span></div>
        <div class="stat"><b>${dayStreak()}</b><span>jours d’affilée</span></div>
      </div>
      <h2>Mes matières</h2>
      <div class="card">
        ${subjects.map(s => `
          <div class="subject-line">
            <div class="grow">
              <div class="row between"><b>${esc(s.m)}</b><span class="small muted">${s.mastered}/${s.total}</span></div>
              <div class="bar" style="margin-top:6px"><span style="width:${pct(s.mastered, s.total)}%"></span></div>
              ${s.due ? `<p class="small muted" style="margin-top:4px">${plural(s.due, 'carte', 'cartes')} à revoir</p>` : ''}
            </div>
          </div>`).join('') || '<p class="muted">Aucune carte pour le moment.</p>'}
      </div>`;
  }

  // ---------- Choix des cartes ----------
  function renderSetup() {
    const groups = tree();
    const allKeys = [];
    for (const [, subs] of groups) for (const [m, chapters] of subs) for (const c of chapters.keys()) allKeys.push(chapterKey(m, c));
    const selected = new Set((state.settings.selection || allKeys).filter(k => allKeys.includes(k)));
    const levels = new Set(state.settings.levels);
    let duration = state.settings.duration;
    const open = new Set();

    function selectedIds() {
      const ids = [];
      for (const [, subs] of groups) for (const [m, chapters] of subs) for (const [c, cids] of chapters) {
        if (selected.has(chapterKey(m, c))) ids.push(...cids);
      }
      return ids.filter(id => levels.has(level(id)));
    }

    function draw() {
      const ids = selectedIds();
      const due = countDue(ids);
      const fresh = ids.filter(isNew).length;
      view().innerHTML = `
        <div class="row" style="margin-bottom:6px">
          <a class="icon-btn" href="#/home" aria-label="Retour">‹</a>
          <h1 class="grow" style="font-size:26px">Réviser</h1>
        </div>
        <h2>Que veux-tu réviser ?</h2>
        ${Array.from(groups).map(([g, subs], gi) => {
          const gKeys = [];
          for (const [m, chapters] of subs) for (const c of chapters.keys()) gKeys.push(chapterKey(m, c));
          const gSel = gKeys.filter(k => selected.has(k)).length;
          return `
          <div class="card group-head" style="padding:12px 16px;margin-bottom:10px">
            <input type="checkbox" class="check" data-group="${esc(g)}" id="g-${gi}" ${gSel === gKeys.length ? 'checked' : ''}>
            <label class="grow" for="g-${gi}"><b>Tout le domaine « ${esc(g)} »</b><div class="small muted">${plural(subs.size, 'matière', 'matières')}</div></label>
          </div>
          ${Array.from(subs).map(([m, chapters], si) => {
            const keys = Array.from(chapters.keys()).map(c => chapterKey(m, c));
            const nSel = keys.filter(k => selected.has(k)).length;
            const sids = Array.from(chapters.values()).flat();
            const isOpen = open.has(m);
            return `
            <div class="card subject ${isOpen ? 'open' : ''}">
              <div class="subject-head">
                <input type="checkbox" class="check" data-subject="${esc(m)}" aria-label="${esc(m)}" ${nSel === keys.length ? 'checked' : ''}>
                <div class="grow" data-toggle="${esc(m)}">
                  <b>${esc(m)}</b>
                  <div class="small muted">${plural(sids.length, 'carte', 'cartes')} · ${countDue(sids)} à revoir · ${nSel}/${keys.length} thèmes</div>
                </div>
                <button class="icon-btn" data-toggle="${esc(m)}" aria-label="Voir les thèmes"><span class="chev">›</span></button>
              </div>
              ${isOpen ? `<div class="chapters">${Array.from(chapters).map(([c, cids], i) => {
                const k = chapterKey(m, c);
                const done = cids.every(isMastered);
                const cid = `c-${gi}-${si}-${i}`;
                return `
                <div class="chapter">
                  <input type="checkbox" class="check" id="${cid}" data-chapter="${esc(k)}" ${selected.has(k) ? 'checked' : ''}>
                  <label for="${cid}">${esc(c)}<div class="small muted">${plural(cids.length, 'carte', 'cartes')} · ${countDue(cids)} à revoir</div></label>
                  ${done ? '<span class="chip solid">✓ maîtrisé</span>' : ''}
                </div>`;
              }).join('')}</div>` : ''}
            </div>`;
          }).join('')}`;
        }).join('')}

        <h2>Niveau de difficulté</h2>
        <div class="chips">
          ${Object.entries(LEVELS).map(([k, label]) => `<button class="toggle" data-level="${k}" aria-pressed="${levels.has(k)}">${label}s</button>`).join('')}
        </div>

        <h2>Durée de la session</h2>
        <div class="chips">
          ${DURATIONS.map(d => `<button class="toggle" data-duration="${d}" aria-pressed="${d === duration}">${d ? d + ' min' : 'Sans limite'}</button>`).join('')}
        </div>
        <p class="small muted" style="margin-top:14px">Ordre : d’abord les cartes à revoir, puis tes erreurs, puis au maximum ${state.settings.newPerSession} nouvelles cartes. S’il reste du temps, tu continues avec les autres cartes.</p>

        <div class="sticky-cta"><div>
          <p class="small muted center" style="margin-bottom:6px">${plural(ids.length, 'carte sélectionnée', 'cartes sélectionnées')} · ${due} à revoir · ${Math.min(fresh, state.settings.newPerSession)} nouvelles</p>
          <button class="btn primary block" id="start" ${ids.length ? '' : 'disabled'}>Commencer</button>
        </div></div>
        <div style="height:110px"></div>`;

      for (const el of $$('.check[data-group]')) {
        const g = el.dataset.group;
        const keys = [];
        for (const [m, chapters] of groups.get(g)) for (const c of chapters.keys()) keys.push(chapterKey(m, c));
        const n = keys.filter(k => selected.has(k)).length;
        el.indeterminate = n > 0 && n < keys.length;
        el.onchange = () => { keys.forEach(k => (el.checked ? selected.add(k) : selected.delete(k))); draw(); };
      }
      for (const el of $$('.check[data-subject]')) {
        const m = el.dataset.subject;
        const chapters = groups.get(groupOf(m)).get(m);
        const keys = Array.from(chapters.keys()).map(c => chapterKey(m, c));
        const n = keys.filter(k => selected.has(k)).length;
        el.indeterminate = n > 0 && n < keys.length;
        el.onchange = () => { keys.forEach(k => (el.checked ? selected.add(k) : selected.delete(k))); draw(); };
      }
      for (const el of $$('.check[data-chapter]')) {
        el.onchange = () => { el.checked ? selected.add(el.dataset.chapter) : selected.delete(el.dataset.chapter); draw(); };
      }
      for (const el of $$('[data-toggle]')) {
        el.onclick = () => { const m = el.dataset.toggle; open.has(m) ? open.delete(m) : open.add(m); draw(); };
      }
      for (const el of $$('[data-level]')) {
        el.onclick = () => { const k = el.dataset.level; levels.has(k) ? levels.delete(k) : levels.add(k); draw(); };
      }
      for (const el of $$('[data-duration]')) {
        el.onclick = () => { duration = Number(el.dataset.duration); draw(); };
      }
      $('#start').onclick = () => {
        state.settings.selection = Array.from(selected);
        state.settings.levels = Array.from(levels);
        state.settings.duration = duration;
        save();
        startSession(selectedIds(), duration);
      };
    }
    draw();
  }

  // ---------- Session de révision ----------
  function buildQueue(ids) {
    const t = today();
    const rank = { hard: 0, medium: 1, easy: 2, new: 3 };
    const due = ids.filter(id => isDue(id, t)).sort((a, b) => P(a).due - P(b).due || rank[level(a)] - rank[level(b)]);
    const dueSet = new Set(due);
    const errors = ids.filter(id => !dueSet.has(id) && level(id) === 'hard');
    const errSet = new Set(errors);
    const fresh = ids.filter(isNew).slice(0, state.settings.newPerSession);
    const rest = ids.filter(id => !isNew(id) && !dueSet.has(id) && !errSet.has(id)).sort((a, b) => P(a).due - P(b).due);
    const main = [...due, ...errors, ...fresh].map(id => ({ id, retry: false }));
    return { main, extra: rest.map(id => ({ id, retry: false })) };
  }

  function startSession(ids, minutes, endAt) {
    const { main, extra } = buildQueue(ids);
    if (!main.length && !extra.length) { toast('Aucune carte disponible pour cette sélection.'); return; }
    session = {
      ids,
      queue: main,
      extra,
      inExtra: false,
      startedAt: Date.now(),
      endAt: endAt !== undefined ? endAt : minutes ? Date.now() + minutes * 60000 : null,
      results: { correct: 0, partial: 0, wrong: 0 },
      reviewed: [],
      retries: {},
      current: null,
      revealed: false,
      answer: '',
      timeUp: false,
      finished: false
    };
    nextCard();
    go('#/study');
  }

  function nextCard() {
    if (session.timeUp) { finishSession(); return; }
    if (!session.queue.length && session.extra.length) {
      session.queue = session.extra.splice(0, 20);
      session.inExtra = true;
      toast('Révision libre : les cartes que tu connais déjà.');
    }
    if (!session.queue.length) { finishSession(); return; }
    session.current = session.queue.shift();
    session.revealed = false;
    session.answer = '';
  }

  let timerHandle = null;
  function startTimer() {
    endTimer();
    if (!session || !session.endAt) return;
    timerHandle = setInterval(() => {
      const left = session.endAt - Date.now();
      const el = $('#timer');
      if (left <= 0) {
        session.timeUp = true;
        if (el) { el.textContent = 'Temps écoulé'; el.classList.add('low'); }
        endTimer();
        return;
      }
      if (el) { el.textContent = fmtLeft(left); el.classList.toggle('low', left < 60000); }
    }, 1000);
  }
  function endTimer() { clearInterval(timerHandle); timerHandle = null; }
  function fmtLeft(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

  function renderStudy() {
    if (!session || session.finished || !session.current) { go('#/home'); return; }
    const card = BY_ID.get(session.current.id);
    if (!card) { nextCard(); renderStudy(); return; }
    const done = session.reviewed.length;
    const total = done + session.queue.length + 1;
    const lvl = level(card.id);
    const timeLeft = session.endAt ? session.endAt - Date.now() : null;

    view().innerHTML = `
      <div class="study-top">
        <button class="icon-btn" id="quit" aria-label="Terminer la session">✕</button>
        <div class="grow small muted">${session.current.retry ? 'Nouvel essai' : session.inExtra ? 'Révision libre' : `Carte ${done + 1} sur ${total}`}</div>
        <span class="timer small ${timeLeft !== null && timeLeft < 60000 ? 'low' : ''}" id="timer">${session.timeUp ? 'Temps écoulé' : timeLeft !== null ? fmtLeft(timeLeft) : '∞'}</span>
      </div>
      <div class="progress-line"><span style="width:${pct(done, total)}%"></span></div>

      <article class="card flash">
        <div class="row between">
          <span class="meta">${esc(card.m)} · ${esc(card.c)}</span>
          <span class="chip ${lvl === 'hard' ? 'accent' : ''}">${session.current.retry ? 'À retenter' : LEVELS[lvl]}</span>
        </div>
        ${card.t ? `<div class="small muted" style="margin-top:4px">${esc(card.t)}</div>` : ''}
        <p class="question">${rich(card.q)}</p>

        ${session.revealed ? `
          ${session.answer.trim() ? `<div class="answer-block mine"><h3>Ta réponse</h3><p>${esc(session.answer).replace(/\n/g, '<br>')}</p></div>` : ''}
          <div class="answer-block official"><h3>Réponse</h3><p>${rich(card.r)}</p></div>
          ${card.tip ? `<div class="tip">💡 « ${esc(card.tip)} »</div>` : ''}
        ` : `
          <label class="field" style="margin-top:16px">
            <span>Ta réponse</span>
            <textarea id="answer" placeholder="Écris ou dicte ta réponse…" autocomplete="off" autocapitalize="sentences">${esc(session.answer)}</textarea>
          </label>
          <p class="small muted" style="margin-top:6px">🎤 Pour dicter, touche le micro du clavier.</p>
        `}
      </article>

      ${session.revealed ? `
        <div class="sticky-grades"><div>
          <div class="grades">
            <button class="btn primary" data-grade="correct"><span class="sym">✓</span>Correcte</button>
            <button class="btn soft" data-grade="partial"><span class="sym">~</span>Incomplète</button>
            <button class="btn neutral" data-grade="wrong"><span class="sym">✗</span>Incorrecte</button>
          </div>
          <p class="grade-hint">${session.current.retry ? 'Nouvel essai : ta note ne change pas le calendrier de la carte.' : 'Correcte → revient dans ' + CORRECT_INTERVALS[Math.min(P(card.id)?.step || 0, CORRECT_INTERVALS.length - 1)] + ' jours · sinon demain'}</p>
        </div></div>
        <div style="height:130px"></div>
      ` : `
        <button class="btn primary block" id="reveal" style="margin-top:16px">Voir la réponse</button>
      `}`;

    startTimer();

    const ta = $('#answer');
    if (ta) {
      ta.oninput = () => { session.answer = ta.value; };
      ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) reveal(); };
    }
    const btn = $('#reveal');
    if (btn) btn.onclick = reveal;
    for (const b of $$('[data-grade]')) b.onclick = () => onGrade(b.dataset.grade);
    $('#quit').onclick = () => {
      if (!session.reviewed.length || confirm('Terminer la session maintenant ?')) finishSession();
    };
  }

  function reveal() {
    const ta = $('#answer');
    if (ta) session.answer = ta.value;
    session.revealed = true;
    renderStudy();
  }

  function onGrade(g) {
    const item = session.current;
    if (!item.retry) {
      grade(item.id, g);
      session.results[g]++;
      session.reviewed.push({ id: item.id, g });
    }
    // Un nouvel essai ne reprogramme pas la carte : elle revient de toute façon le lendemain.
    if (g === 'wrong') {
      const n = session.retries[item.id] || 0;
      if (n < MAX_RETRIES_IN_SESSION) {
        session.retries[item.id] = n + 1;
        session.queue.splice(Math.min(3, session.queue.length), 0, { id: item.id, retry: true });
      }
    }
    nextCard();
    if (!session.finished) renderStudy();
  }

  function finishSession() {
    endTimer();
    if (!session || session.finished) return;
    session.finished = true;
    if (session.reviewed.length) {
      state.sessions.push({
        at: session.startedAt,
        seconds: Math.round((Date.now() - session.startedAt) / 1000),
        count: session.reviewed.length,
        correct: session.results.correct,
        partial: session.results.partial,
        wrong: session.results.wrong
      });
      state.sessions = state.sessions.slice(-500);
      save();
    }
    go('#/summary');
  }

  function renderSummary() {
    if (!session || !session.finished) { go('#/home'); return; }
    const r = session.results;
    const n = session.reviewed.length;
    const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    const misses = session.reviewed.filter(x => x.g !== 'correct').map(x => BY_ID.get(x.id)).filter(Boolean);
    const tomorrow = addDays(today(), 1);
    const dueTomorrow = CARDS.filter(c => !isNew(c.id) && P(c.id).due <= tomorrow).length;
    // Le temps choisi n'est pas écoulé : on propose de continuer avec la même sélection.
    const msLeft = session.endAt ? session.endAt - Date.now() : null;
    const timeLeft = msLeft !== null ? Math.ceil(msLeft / 60000) : null;
    const { main, extra } = buildQueue(session.ids.filter(id => BY_ID.has(id)));
    const canContinue = (msLeft === null || msLeft > 30000) && (main.length + extra.length) > 0;

    view().innerHTML = `
      <h1>Bilan</h1>
      <section class="hero">
        ${n ? `
          <div class="big-number">${pct(r.correct, n)} %</div>
          <p class="muted">de réponses correctes · ${plural(n, 'carte', 'cartes')} en ${minutes} min</p>
          <div class="result-bar" style="margin-top:16px">
            <span class="c" style="width:${pct(r.correct, n)}%"></span>
            <span class="p" style="width:${pct(r.partial, n)}%"></span>
            <span class="w" style="width:${pct(r.wrong, n)}%"></span>
          </div>
          <div class="legend">
            <span><span class="dot" style="background:var(--accent)"></span>${plural(r.correct, 'correcte', 'correctes')}</span>
            <span><span class="dot" style="background:var(--accent-soft);outline:1px solid var(--accent)"></span>${plural(r.partial, 'incomplète', 'incomplètes')}</span>
            <span><span class="dot" style="background:var(--cloudy)"></span>${plural(r.wrong, 'incorrecte', 'incorrectes')}</span>
          </div>` : '<p class="muted">Aucune carte notée pendant cette session.</p>'}
        <p class="small muted" style="margin-top:14px">${plural(dueTomorrow, 'carte', 'cartes')} à revoir d’ici demain.</p>
      </section>
      ${misses.length ? `
        <h2>À retravailler</h2>
        <div class="card">${misses.map(c => `
          <a class="list-item" href="#/card/${encodeURIComponent(c.id)}">
            <div class="grow"><div class="q">${esc(plain(c.q))}</div><div class="small muted">${esc(c.m)}</div></div>
            <span class="muted">›</span>
          </a>`).join('')}</div>` : ''}
      <div class="stack" style="margin-top:20px">
        ${canContinue ? `<button class="btn primary block" id="continue">Continuer${timeLeft ? ` · encore ${timeLeft} min` : ''}</button>` : ''}
        <a class="btn ${canContinue ? 'ghost' : 'primary'} block" href="#/setup">Nouvelle sélection</a>
        <a class="btn ghost block" href="#/home">Accueil</a>
      </div>`;

    const cont = $('#continue');
    if (cont) cont.onclick = () => startSession(session.ids, null, session.endAt);
  }

  // ---------- Progrès ----------
  function renderProgress() {
    const groups = tree();
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(addDays(today(), -i));
    const perDay = days.map(d => state.sessions.filter(s => s.at >= d && s.at < addDays(d, 1)).reduce((a, s) => a + s.count, 0));
    const maxDay = Math.max(1, ...perDay);
    const totals = Object.values(state.progress).reduce((a, p) => { a.r += p.reviews; a.c += p.correct; return a; }, { r: 0, c: 0 });
    const hard = CARDS.filter(c => !isNew(c.id))
      .map(c => ({ c, rate: (P(c.id).wrong + 0.5 * P(c.id).partial) / P(c.id).reviews }))
      .filter(x => x.rate > 0)
      .sort((a, b) => b.rate - a.rate || P(b.c.id).reviews - P(a.c.id).reviews)
      .slice(0, 10);

    view().innerHTML = `
      <h1>Progrès</h1>
      <div class="stats-grid" style="margin-top:18px">
        <div class="stat"><b>${totals.r}</b><span>révisions</span></div>
        <div class="stat"><b>${pct(totals.c, totals.r)} %</b><span>de réussite</span></div>
        <div class="stat"><b>${CARDS.filter(c => isMastered(c.id)).length}</b><span>maîtrisées</span></div>
      </div>

      <h2>14 derniers jours</h2>
      <div class="card">
        <div class="activity">${perDay.map((n, i) => `<div class="${n ? '' : 'zero'}" style="height:${n ? Math.max(6, (n / maxDay) * 100) : 3}%" title="${fmtDate(days[i])} : ${n} cartes"></div>`).join('')}</div>
        <div class="activity-labels"><span>${fmtDate(days[0])}</span><span>aujourd’hui</span></div>
      </div>

      ${Array.from(groups).map(([, subs]) => Array.from(subs).map(([m, chapters]) => {
        const sids = Array.from(chapters.values()).flat();
        const reviewed = sids.filter(id => !isNew(id));
        const rv = reviewed.reduce((a, id) => { a.r += P(id).reviews; a.c += P(id).correct; return a; }, { r: 0, c: 0 });
        return `
        <h2>${esc(m)}</h2>
        <div class="card">
          <div class="row between small muted">
            <span>${sids.filter(isMastered).length}/${sids.length} maîtrisées</span>
            <span>${pct(rv.c, rv.r)} % de réussite</span>
            <span>${countDue(sids)} à revoir</span>
          </div>
          ${Array.from(chapters).map(([c, cids]) => {
            const mastered = cids.filter(isMastered).length;
            const seen = cids.filter(id => !isNew(id)).length;
            return `
            <div style="margin-top:14px">
              <div class="row between">
                <span class="grow">${esc(c)}</span>
                ${mastered === cids.length ? '<span class="chip solid">✓ maîtrisé</span>' : `<span class="small muted">${mastered}/${cids.length}</span>`}
              </div>
              <div class="bar" style="margin-top:6px"><span style="width:${pct(mastered, cids.length)}%"></span></div>
              <div class="small muted" style="margin-top:3px">${seen}/${cids.length} déjà vues</div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')).join('')}

      <h2>Cartes les plus difficiles</h2>
      <div class="card">
        ${hard.length ? hard.map(({ c, rate }) => `
          <a class="list-item" href="#/card/${encodeURIComponent(c.id)}">
            <div class="grow"><div class="q">${esc(plain(c.q))}</div><div class="small muted">${esc(c.m)} · ${pct(rate * P(c.id).reviews, P(c.id).reviews)} % d’erreurs sur ${P(c.id).reviews}</div></div>
            <span class="muted">›</span>
          </a>`).join('') : '<p class="muted">Pas encore d’erreurs enregistrées.</p>'}
      </div>`;
  }

  // ---------- Cartes ----------
  let cardsFilter = { m: '', q: '' };

  function renderCards() {
    const subjects = Array.from(new Set(CARDS.map(c => c.m)));
    function draw() {
      const q = cardsFilter.q.trim().toLowerCase();
      const list = CARDS.filter(c => (!cardsFilter.m || c.m === cardsFilter.m) && (!q || (c.q + ' ' + c.r + ' ' + (c.t || '')).toLowerCase().includes(q)));
      const byChapter = new Map();
      for (const c of list) {
        const k = `${c.m} · ${c.c}`;
        if (!byChapter.has(k)) byChapter.set(k, []);
        byChapter.get(k).push(c);
      }
      $('#card-list').innerHTML = list.length ? Array.from(byChapter).map(([k, cards]) => `
        <h2 style="font-size:17px">${esc(k)}</h2>
        <div class="card">${cards.map(c => `
          <a class="list-item" href="#/card/${encodeURIComponent(c.id)}">
            <div class="grow"><div class="q">${esc(plain(c.q))}</div>
              <div class="small muted">${LEVELS[level(c.id)]}${c.custom ? ' · ajoutée par toi' : c.edited ? ' · modifiée' : ''}</div></div>
            <span class="muted">›</span>
          </a>`).join('')}</div>`).join('') : '<div class="empty">Aucune carte ne correspond.</div>';
    }

    view().innerHTML = `
      <h1>Cartes</h1>
      <div class="stack" style="margin-top:16px">
        <select id="f-subject" aria-label="Matière">
          <option value="">Toutes les matières (${CARDS.length})</option>
          ${subjects.map(m => `<option value="${esc(m)}" ${m === cardsFilter.m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <input type="search" id="f-search" placeholder="Rechercher…" value="${esc(cardsFilter.q)}" aria-label="Rechercher">
      </div>
      <div id="card-list"></div>
      <button class="fab" id="add" aria-label="Ajouter une carte">+</button>`;

    $('#f-subject').onchange = e => { cardsFilter.m = e.target.value; draw(); };
    $('#f-search').oninput = e => { cardsFilter.q = e.target.value; draw(); };
    $('#add').onclick = () => go('#/edit/new');
    draw();
  }

  function renderCard(id) {
    const c = BY_ID.get(id);
    if (!c) { go('#/cards'); return; }
    const p = P(id);
    view().innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <button class="icon-btn" id="back" aria-label="Retour">‹</button>
        <span class="grow small muted">${esc(c.m)} · ${esc(c.c)}</span>
      </div>
      <article class="card flash">
        <div class="row between"><span class="meta">${esc(c.t || '')}</span><span class="chip">${LEVELS[level(id)]}</span></div>
        <p class="question">${rich(c.q)}</p>
        <div class="answer-block official"><h3>Réponse</h3><p>${rich(c.r)}</p></div>
        ${c.tip ? `<div class="tip">💡 « ${esc(c.tip)} »</div>` : ''}
      </article>
      <div class="card">
        ${p && p.reviews ? `
          <p>${plural(p.reviews, 'révision', 'révisions')} · ${p.correct} correctes · ${p.partial} incomplètes · ${p.wrong} incorrectes</p>
          <p class="small muted" style="margin-top:4px">${dueLabel(id)}${isMastered(id) ? ' · maîtrisée' : ''}</p>` : '<p class="muted">Cette carte n’a pas encore été révisée.</p>'}
      </div>
      <div class="stack" style="margin-top:16px">
        <a class="btn ghost block" href="#/edit/${encodeURIComponent(id)}">Modifier la carte</a>
        ${p && p.reviews ? '<button class="btn ghost block" id="reset">Remettre sa progression à zéro</button>' : ''}
        <button class="btn danger block" id="delete">${c.custom ? 'Supprimer la carte' : 'Retirer la carte de mes révisions'}</button>
      </div>`;

    $('#back').onclick = () => history.back();
    const reset = $('#reset');
    if (reset) reset.onclick = () => {
      if (!confirm('Remettre la progression de cette carte à zéro ?')) return;
      delete state.progress[id];
      save();
      renderCard(id);
      toast('Progression remise à zéro.');
    };
    $('#delete').onclick = () => {
      if (!confirm(c.custom ? 'Supprimer définitivement cette carte ?' : 'Retirer cette carte de tes révisions ? Tu pourras la récupérer dans les réglages.')) return;
      if (c.custom) state.custom = state.custom.filter(x => x.id !== id);
      else state.hidden[id] = Date.now();
      save();
      refreshCards();
      go('#/cards');
      toast('Carte retirée.');
    };
  }

  function renderEdit(id) {
    const isNewCard = id === 'new';
    const c = isNewCard ? { m: cardsFilter.m || '', c: '', t: '', q: '', r: '', tip: '' } : BY_ID.get(id);
    if (!c) { go('#/cards'); return; }
    const subjects = Array.from(new Set(CARDS.map(x => x.m)));
    const chaptersOf = m => Array.from(new Set(CARDS.filter(x => x.m === m).map(x => x.c)));
    const themesOf = m => Array.from(new Set(CARDS.filter(x => x.m === m && x.t).map(x => x.t)));

    view().innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <button class="icon-btn" id="back" aria-label="Retour">‹</button>
        <h1 class="grow" style="font-size:26px">${isNewCard ? 'Nouvelle carte' : 'Modifier la carte'}</h1>
      </div>
      <form id="edit-form" class="stack" autocomplete="off">
        <label class="field"><span>Matière</span>
          <input type="text" name="m" list="dl-m" required value="${esc(c.m)}" placeholder="Ex. Fiscalité directe">
        </label>
        <datalist id="dl-m">${subjects.map(m => `<option value="${esc(m)}">`).join('')}</datalist>
        <label class="field"><span>Thème (chapitre)</span>
          <input type="text" name="c" list="dl-c" required value="${esc(c.c)}" placeholder="Ex. 2. Revenu PP">
        </label>
        <datalist id="dl-c"></datalist>
        <label class="field"><span>Sous-thème (facultatif)</span>
          <input type="text" name="t" list="dl-t" value="${esc(c.t || '')}">
        </label>
        <datalist id="dl-t"></datalist>
        <label class="field"><span>Question</span>
          <textarea name="q" required>${esc(c.q)}</textarea>
        </label>
        <label class="field"><span>Réponse</span>
          <textarea name="r" required>${esc(c.r)}</textarea>
        </label>
        <p class="small muted">Astuce : entoure un mot de **deux étoiles** pour l’afficher en gras.</p>
        <label class="field"><span>Moyen mnémotechnique (facultatif)</span>
          <input type="text" name="tip" value="${esc(c.tip || '')}">
        </label>
        <button class="btn primary block" type="submit">Enregistrer</button>
        ${!isNewCard && c.edited ? '<button class="btn ghost block" type="button" id="restore">Revenir à la version d’origine</button>' : ''}
      </form>`;

    const form = $('#edit-form');
    const fillLists = () => {
      const m = form.m.value.trim();
      $('#dl-c').innerHTML = chaptersOf(m).map(x => `<option value="${esc(x)}">`).join('');
      $('#dl-t').innerHTML = themesOf(m).map(x => `<option value="${esc(x)}">`).join('');
    };
    form.m.oninput = fillLists;
    fillLists();
    $('#back').onclick = () => history.back();

    form.onsubmit = e => {
      e.preventDefault();
      const data = {};
      for (const k of ['m', 'c', 't', 'q', 'r', 'tip']) data[k] = form[k].value.trim();
      data.updatedAt = Date.now();
      let targetId = id;
      if (isNewCard) {
        targetId = 'u-' + Date.now().toString(36);
        state.custom.push(Object.assign({ id: targetId, createdAt: Date.now() }, data));
      } else if (c.custom) {
        const i = state.custom.findIndex(x => x.id === id);
        state.custom[i] = Object.assign({}, state.custom[i], data);
      } else {
        state.edits[id] = data;
      }
      save();
      refreshCards();
      toast(isNewCard ? 'Carte ajoutée.' : 'Carte enregistrée.');
      location.replace('#/card/' + encodeURIComponent(targetId));
    };

    const restore = $('#restore');
    if (restore) restore.onclick = () => {
      delete state.edits[id];
      save();
      refreshCards();
      location.replace('#/card/' + encodeURIComponent(id));
      toast('Version d’origine rétablie.');
    };
  }

  // ---------- Réglages ----------
  function renderSettings() {
    const s = state.settings;
    const hiddenCount = Object.keys(state.hidden).length;
    view().innerHTML = `
      <h1>Réglages</h1>

      <h2>Révision</h2>
      <div class="card stack">
        <div class="row between">
          <div class="grow"><b>Nouvelles cartes par session</b><div class="small muted">Pour ne pas être submergée</div></div>
          <div class="row">
            <button class="icon-btn" id="new-minus" aria-label="Moins">−</button>
            <b id="new-val" style="min-width:28px;text-align:center">${s.newPerSession}</b>
            <button class="icon-btn" id="new-plus" aria-label="Plus">+</button>
          </div>
        </div>
        <label class="field"><span>Date de l’examen</span>
          <input type="date" id="exam" value="${esc(s.examDate)}">
        </label>
        <p class="small muted">Cartes réussies : retour après 2 jours, puis 4 jours, puis tous les 8 jours. Incomplète ou incorrecte : retour le lendemain.</p>
      </div>

      <h2>Apparence</h2>
      <div class="chips">
        ${[['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<button class="toggle" data-theme-choice="${k}" aria-pressed="${s.theme === k}">${l}</button>`).join('')}
      </div>

      <h2>Sauvegarde et synchronisation</h2>
      <div class="card stack">
        <p class="small muted">La synchronisation automatique entre ton iPhone et ton iPad sera activée lors de la mise en ligne. En attendant, tu peux exporter tes progrès et les importer sur un autre appareil.</p>
        <button class="btn ghost block" id="export">Exporter mes progrès</button>
        <label class="btn ghost block" for="import-file">Importer une sauvegarde</label>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>

      <h2>Données</h2>
      <div class="card stack">
        <p class="small muted">${plural(CARDS.length, 'carte active', 'cartes actives')} · ${plural(state.custom.length, 'carte ajoutée', 'cartes ajoutées')} · ${plural(hiddenCount, 'carte retirée', 'cartes retirées')}</p>
        ${hiddenCount ? '<button class="btn ghost block" id="unhide">Récupérer les cartes retirées</button>' : ''}
        <button class="btn danger block" id="wipe">Effacer toute ma progression</button>
      </div>
      <p class="small muted center" style="margin-top:24px">Mémoria · fonctionne hors ligne</p>`;

    const setNew = n => { s.newPerSession = Math.max(1, Math.min(50, n)); $('#new-val').textContent = s.newPerSession; save(); };
    $('#new-minus').onclick = () => setNew(s.newPerSession - 1);
    $('#new-plus').onclick = () => setNew(s.newPerSession + 1);
    $('#exam').onchange = e => { if (e.target.value) { s.examDate = e.target.value; save(); toast('Date enregistrée.'); } };
    for (const b of $$('[data-theme-choice]')) b.onclick = () => { s.theme = b.dataset.themeChoice; save(); applyTheme(); renderSettings(); };

    $('#export').onclick = () => {
      const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `memoria-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('#import-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const other = JSON.parse(await file.text());
        if (!other || typeof other.progress !== 'object') throw new Error('format');
        mergeState(other);
        save();
        refreshCards();
        toast('Sauvegarde importée.');
        renderSettings();
      } catch (err) {
        toast('Ce fichier n’est pas une sauvegarde Mémoria.');
      }
    };
    const unhide = $('#unhide');
    if (unhide) unhide.onclick = () => { state.hidden = {}; save(); refreshCards(); renderSettings(); toast('Cartes récupérées.'); };
    $('#wipe').onclick = () => {
      if (!confirm('Effacer toute ta progression ? Tes cartes ajoutées sont conservées.')) return;
      if (!confirm('Vraiment ? Cette action est définitive.')) return;
      state.progress = {};
      state.sessions = [];
      save();
      toast('Progression effacée.');
      renderSettings();
    };
  }

  // ---------- Démarrage ----------
  applyTheme();
  refreshCards();
  window.addEventListener('hashchange', render);
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
