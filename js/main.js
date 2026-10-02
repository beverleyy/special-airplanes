import { serverSource } from "./api.js";
import { airportTime } from "./clock.js";
import { demoSource } from "./demo.js";
import { activeRegs, buildVisits, isGone, selectVisits, splitNowAndLater } from "./flights.js";
import { normReg } from "./format.js";
import { holdSign, progress } from "./views/common.js";
import { creditHtml, demoCreditHtml } from "./views/credit.js";
import { directionFilterHtml, typeFilterHtml } from "./views/filters.js";
import { emptyHtml, resultsHtml, summaryHtml } from "./views/results.js";
import { tailHtml } from "./views/tail.js";

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
  el.credit.innerHTML = state.source.isDemo
    ? demoCreditHtml(state.source.recording)
    : creditHtml(state.database, state.registry.size);
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
  el.status.innerHTML = progress(`Reading the ${code} arrivals and departures boards…`);
  try {
    const board = await state.source.board(code, { fresh });
    if (search !== state.search) return;
    state.board = board;
    state.live = new Map();
    state.boardIsNew = true;
    el.status.innerHTML = "";
    el.updated.textContent = updatedText();
    el.refresh.hidden = false;
    renderBoard();
    setParam("airport", code);
    await Promise.all([loadRestOfBoard(code, search), loadLive(code, search)]);
  } catch (error) {
    if (search === state.search) el.status.innerHTML = holdSign(error.message);
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

async function connect() {
  try {
    const summary = await serverSource.summary();
    return { source: serverSource, summary };
  } catch {
    const source = await demoSource();
    return { source, summary: await source.summary() };
  }
}

async function start() {
  bindEvents();
  const { source, summary } = await connect();
  state.source = source;
  el.localNote.hidden = source.isDemo;
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

start().catch(error => {
  el.status.innerHTML = holdSign(`Livery Watch couldn't start: ${error.message}`);
});
