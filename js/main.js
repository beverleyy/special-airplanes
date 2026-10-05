import { serverSource } from "./api.js";
import { airportTime } from "./clock.js";
import { WORKER_URL } from "./config.js";
import { demoSource } from "./demo.js";
import { activeRegs, buildVisits, isGone, selectVisits, splitNowAndLater } from "./flights.js";
import { escapeHtml, normReg } from "./format.js";
import { filterLive, mergeLive, splitLive } from "./live.js";
import { accessCardHtml, modeSwitchHtml } from "./views/access.js";
import { holdSign, progress } from "./views/common.js";
import { creditHtml, demoCreditHtml, liveCreditHtml } from "./views/credit.js";
import { directionFilterHtml, typeFilterHtml } from "./views/filters.js";
import { liveEmptyHtml, liveResultsHtml, liveSummaryHtml } from "./views/live.js";
import { emptyHtml, resultsHtml, summaryHtml } from "./views/results.js";
import { tailHtml } from "./views/tail.js";
import { AccessCodeError, forgetAccessCode, saveAccessCode, workerSource } from "./worker-api.js";

const IMPORT_POLL_MS = 2000;
const BOARD_POLL_MS = 1000;
const AIRPORT_CODE = /^[A-Z0-9]{3}$/;

const $ = id => document.getElementById(id);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const el = {
  airportForm: $("airport-form"),
  airport: $("airport"),
  airportSubmit: $("airport-submit"),
  updated: $("updated"),
  refresh: $("refresh"),
  credit: $("credit"),
  localNote: $("local-note"),
  tailForm: $("tail-form"),
  tail: $("tail"),
  tailSubmit: $("tail-submit"),
  tailResult: $("tail-result"),
  aircraftSearch: $("aircraft-search"),
  jumpToAircraft: $("jump-to-aircraft"),
  filters: $("filters"),
  directionFilter: $("direction-filter"),
  typeFilter: $("type-filter"),
  status: $("status"),
  modeSwitch: $("mode-switch"),
  searchTitle: $("search-title"),
  summary: $("summary"),
  results: $("results"),
};

const state = {
  source: null,
  registry: new Map(),
  prefs: { types: [], direction: "both" },
  database: null,
  board: null,
  live: new Map(),
  nearby: null,
  inbound: null,
  inboundState: "",
  notice: "",
  selectedTail: "",
  boardIsNew: false,
  search: 0,
};

// URL

function setParam(name, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  history.replaceState(null, "", url);
}

const getParam = name => new URLSearchParams(location.search).get(name);

// Registry and credit

function applySummary(summary) {
  state.registry = new Map(summary.registry.map(entry => [normReg(entry.reg), entry]));
  state.prefs = summary.prefs;
  state.database = summary.database;
  renderCredit();
  renderBoard();
}

function renderCredit() {
  if (state.source.kind === "live") el.credit.innerHTML = liveCreditHtml(state.database);
  else if (state.source.isDemo) el.credit.innerHTML = demoCreditHtml(state.source.recording, { liveAvailable: !!WORKER_URL });
  else el.credit.innerHTML = creditHtml(state.database, state.registry.size);
  if (state.notice) el.credit.insertAdjacentHTML("beforeend", `<span class="credit__warn">${escapeHtml(state.notice)}</span>`);
}

async function watchImport() {
  while (state.database?.state === "running") {
    await wait(IMPORT_POLL_MS);
    try {
      const status = await state.source.importStatus();
      if (status.state === "running") continue;
      applySummary(await state.source.summary());
    } catch {
      return;
    }
  }
}

// Airport board

function renderBoard() {
  if (state.source?.kind === "live") {
    renderLiveBoard();
    return;
  }
  const { board, live, prefs, registry } = state;
  if (!board) return;
  const visits = buildVisits(board.flights, registry).filter(v => !isGone(v, live));
  const shown = selectVisits(visits, prefs);

  el.filters.hidden = false;
  el.directionFilter.innerHTML = directionFilterHtml(visits, prefs.direction);
  el.typeFilter.innerHTML = typeFilterHtml(visits, prefs);
  el.summary.innerHTML = summaryHtml(board, shown.length);
  el.results.classList.toggle("results--entering", state.boardIsNew);
  state.boardIsNew = false;
  el.results.innerHTML = shown.length
    ? resultsHtml(splitNowAndLater(shown, live), board, { live, selectedTail: state.selectedTail })
    : emptyHtml(board, visits.length);
}

function renderLiveBoard() {
  const { nearby, inbound, prefs } = state;
  if (!nearby) return;
  const items = mergeLive(nearby, inbound);
  const shown = filterLive(items, prefs);

  el.filters.hidden = false;
  el.directionFilter.innerHTML = directionFilterHtml(items, prefs.direction);
  el.typeFilter.innerHTML = typeFilterHtml(items, prefs);
  el.summary.innerHTML = liveSummaryHtml(nearby, inbound, shown.length, state.inboundState);
  el.results.classList.toggle("results--entering", state.boardIsNew);
  state.boardIsNew = false;
  el.results.innerHTML = shown.length
    ? liveResultsHtml(splitLive(shown), nearby.airport, { selectedTail: state.selectedTail })
    : liveEmptyHtml(nearby, items.length);
}

function updatedText() {
  if (state.source.recording) return `Replaying ${airportTime(state.board.airport)}.`;
  return `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
}

async function loadLive(code, search) {
  const regs = activeRegs(buildVisits(state.board.flights, state.registry));
  if (!regs.length) return;
  try {
    const positions = await state.source.live(code, regs);
    if (search !== state.search) return;
    state.live = new Map(Object.entries(positions).map(([reg, position]) => [normReg(reg), position]));
    renderBoard();
  } catch {
    // Live positions are a bonus; the board is still useful without them.
  }
}

/** Show the first pages straight away, then keep asking until the whole board is in. */
async function loadRestOfBoard(code, search) {
  while (!state.board.complete) {
    const { arr, dep } = state.board.counts;
    el.status.innerHTML = progress(`Loading later flights… ${arr + dep} checked so far.`);
    await wait(BOARD_POLL_MS);
    if (search !== state.search) return;
    const board = await state.source.board(code);
    if (search !== state.search) return;
    state.board = board;
    renderBoard();
  }
  el.status.innerHTML = "";
}

function showBoard(code) {
  state.boardIsNew = true;
  el.status.innerHTML = "";
  el.updated.textContent = updatedText();
  el.refresh.hidden = false;
  renderBoard();
  setParam("airport", code);
}

async function loadScheduledBoard(code, search, fresh) {
  el.status.innerHTML = progress(`Reading the ${code} arrivals and departures boards…`);
  const board = await state.source.board(code, { fresh });
  if (search !== state.search) return;
  state.board = board;
  state.live = new Map();
  showBoard(code);
  await Promise.all([loadRestOfBoard(code, search), loadLive(code, search)]);
}

/** Nearby aircraft first, then special liveries in the air anywhere that are flying here. */
async function loadLiveBoard(code, search) {
  el.status.innerHTML = progress(`Checking for special liveries around ${code}…`);
  const nearby = await state.source.nearby(code);
  if (search !== state.search) return;
  Object.assign(state, { nearby, inbound: null, inboundState: "loading" });
  showBoard(code);
  try {
    const inbound = await state.source.inbound(code);
    if (search !== state.search) return;
    Object.assign(state, { inbound, inboundState: "done" });
  } catch (error) {
    if (search !== state.search) return;
    state.inboundState = error.message;
  }
  renderBoard();
}

async function searchAirport({ fresh = false } = {}) {
  const code = el.airport.value.trim().toUpperCase();
  if (!AIRPORT_CODE.test(code)) {
    el.status.innerHTML = holdSign("Enter a 3-letter IATA airport code, like SFO or HND.");
    el.airport.focus();
    return;
  }
  const search = ++state.search;
  el.airportSubmit.disabled = true;
  el.refresh.disabled = true;
  try {
    if (state.source.kind === "live") await loadLiveBoard(code, search);
    else await loadScheduledBoard(code, search, fresh);
  } catch (error) {
    if (error instanceof AccessCodeError) {
      forgetAccessCode();
      showAccessCard({ reason: "Your access code isn't accepted anymore." });
    } else if (search === state.search) {
      el.status.innerHTML = holdSign(error.message);
    }
  } finally {
    if (search === state.search) {
      el.airportSubmit.disabled = false;
      el.refresh.disabled = false;
    }
  }
}

function savePrefs(changes) {
  state.prefs = { ...state.prefs, ...changes };
  renderBoard();
  state.source.savePrefs(state.prefs).catch(() => {});
}

// Tail lookup

const scrollBehavior = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

function showAircraftSearch() {
  el.aircraftSearch.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
}

async function lookupTail(raw) {
  const reg = raw.trim().toUpperCase();
  if (!reg) {
    el.tail.focus();
    return;
  }
  el.tail.value = reg;
  showAircraftSearch();
  el.tailSubmit.disabled = true;
  el.tailResult.innerHTML = `<p>${progress(`Looking up ${reg}…`)}</p>`;
  try {
    const result = await state.source.tail(reg);
    el.tailResult.innerHTML = tailHtml(result, {
      airportCode: el.airport.value.trim().toUpperCase(),
      isDemo: state.source.isDemo,
    });
    setParam("tail", reg);
    selectTail(result.special ? result.entry.reg : "");
  } catch (error) {
    el.tailResult.innerHTML = holdSign(error.message);
    selectTail("");
  } finally {
    showAircraftSearch();
    el.tailSubmit.disabled = false;
  }
}

function selectTail(reg) {
  state.selectedTail = normReg(reg);
  renderBoard();
}

function closeTail() {
  el.tailResult.innerHTML = "";
  setParam("tail", null);
  selectTail("");
}

// Events

function bindEvents() {
  el.airportForm.addEventListener("submit", event => {
    event.preventDefault();
    searchAirport();
  });
  el.refresh.addEventListener("click", () => searchAirport({ fresh: true }));

  el.directionFilter.addEventListener("click", event => {
    const button = event.target.closest("[data-direction]");
    if (button) savePrefs({ direction: button.dataset.direction });
  });
  el.typeFilter.addEventListener("click", event => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    const type = button.dataset.type;
    const { types } = state.prefs;
    savePrefs({ types: !type ? [] : types.includes(type) ? types.filter(t => t !== type) : [...types, type] });
  });

  el.tailForm.addEventListener("submit", event => {
    event.preventDefault();
    lookupTail(el.tail.value);
  });
  el.tailResult.addEventListener("click", event => {
    if (event.target.closest("[data-action='close-tail']")) closeTail();
  });
  el.results.addEventListener("click", event => {
    if (event.target.closest("[data-action='show-schedule']")) {
      showAircraftSearch();
      return;
    }
    const button = event.target.closest("[data-tail]");
    if (button) lookupTail(button.dataset.tail);
  });
  el.jumpToAircraft.addEventListener("click", event => {
    event.preventDefault();
    showAircraftSearch();
    el.tail.focus({ preventScroll: true });
  });
}

// Start

/** The local server if one is running, else your Worker if configured, else the demo. */
async function connect() {
  try {
    return { source: serverSource, summary: await serverSource.summary() };
  } catch {
    // No local server: this is the static site.
  }
  let notice = "";
  if (WORKER_URL && getParam("demo") === null) {
    const source = workerSource(WORKER_URL);
    try {
      return { source, summary: await source.summary() };
    } catch (error) {
      if (error instanceof AccessCodeError) return { source, needsCode: error.message };
      notice = `The live version isn't reachable right now (${error.message}), so this is the demo.`;
    }
  }
  const source = await demoSource();
  return { source, summary: await source.summary(), notice };
}

// Access code and Demo / Live switch

/** The demo only has its recorded airport, so switching to it starts fresh on that recording. */
function switchTo(mode) {
  const url = new URL(location.href);
  url.searchParams.delete("code");
  if (mode === "demo") {
    url.search = "";
    url.searchParams.set("demo", "");
  } else {
    url.searchParams.delete("demo");
  }
  location.assign(url);
}

/** Shown when this site has a live version: on the static site, not when served by the local server. */
function renderModeSwitch({ unlocked = false } = {}) {
  const hasChoice = !!WORKER_URL && (state.source.kind === "live" || state.source.isDemo);
  el.modeSwitch.hidden = !hasChoice;
  if (hasChoice) el.modeSwitch.innerHTML = modeSwitchHtml(state.source.isDemo ? "demo" : "live", { unlocked });
}

function showAccessCard(options) {
  Object.assign(state, { board: null, nearby: null, inbound: null });
  el.filters.hidden = true;
  el.summary.innerHTML = "";
  el.results.innerHTML = "";
  el.status.innerHTML = accessCardHtml(options);
  renderModeSwitch();
  document.getElementById("access-code").focus();
}

function accessError(message) {
  const error = document.getElementById("access-error");
  error.textContent = message;
  error.hidden = false;
  const input = document.getElementById("access-code");
  input.setAttribute("aria-invalid", "true");
  input.select();
}

/** Checks the code with the Worker, then carries on into the live site without a reload. */
async function unlock(code) {
  const submit = document.getElementById("access-submit");
  if (!code) {
    accessError("Enter the access code you were given.");
    return;
  }
  submit.disabled = true;
  submit.textContent = "Checking…";
  saveAccessCode(code);
  try {
    const summary = await state.source.summary();
    el.status.innerHTML = "";
    await begin(summary);
  } catch (error) {
    if (error instanceof AccessCodeError) {
      forgetAccessCode();
      accessError("That code didn't work. Check it and try again.");
    } else {
      accessError(`Couldn't reach the live data right now (${error.message}). Try again in a moment.`);
    }
    submit.disabled = false;
    submit.textContent = "Unlock live data";
  }
}

function bindAccessEvents() {
  el.status.addEventListener("submit", event => {
    if (event.target.id !== "access-form") return;
    event.preventDefault();
    unlock(document.getElementById("access-code").value.trim());
  });
  el.status.addEventListener("click", event => {
    const reveal = event.target.closest("[data-action='toggle-code']");
    if (reveal) {
      const input = document.getElementById("access-code");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      reveal.textContent = showing ? "Show" : "Hide";
      reveal.setAttribute("aria-pressed", String(!showing));
      input.focus();
      return;
    }
    if (event.target.closest("[data-mode='demo']")) switchTo("demo");
  });
  el.modeSwitch.addEventListener("click", event => {
    if (event.target.closest("[data-action='forget-code']")) {
      forgetAccessCode();
      switchTo("live");
      return;
    }
    const option = event.target.closest("[data-mode]");
    const current = state.source.isDemo ? "demo" : "live";
    if (option && option.dataset.mode !== current) switchTo(option.dataset.mode);
  });
}

/** Access links carry the code as ?code=…; save it and take it out of the address bar. */
function takeCodeFromLink() {
  const code = getParam("code");
  if (!code) return;
  saveAccessCode(code);
  setParam("code", null);
}

/** Everything after the data source is ready: credit, filters, and any airport or tail in the link. */
async function begin(summary) {
  const { source } = state;
  el.localNote.hidden = source.kind !== "scheduled" || source.isDemo;
  renderModeSwitch({ unlocked: source.kind === "live" });
  applySummary(summary);
  watchImport();

  const airport = getParam("airport") || source.airportCode;
  if (airport) {
    el.airport.value = airport;
    await searchAirport();
  }
  const tail = getParam("tail");
  if (tail) lookupTail(tail);
}

async function start() {
  takeCodeFromLink();
  bindEvents();
  bindAccessEvents();
  const { source, summary, needsCode, notice } = await connect();
  state.source = source;
  state.notice = notice || "";
  if (source.kind === "live") el.searchTitle.textContent = "Special liveries around right now";
  if (needsCode) {
    forgetAccessCode();
    showAccessCard();
    return;
  }
  await begin(summary);
}

start().catch(error => {
  el.status.innerHTML = holdSign(`Livery Watch couldn't start: ${error.message}`);
});
