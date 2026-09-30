import { nowSeconds, startClockAt } from "./clock.js";
import { normReg } from "./format.js";
import { sampleRecording } from "./sample.js";

const RECORDING_URL = "demo-data.json";

async function loadRecording() {
  try {
    const response = await fetch(RECORDING_URL, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Schedule rows for a tail, built from the board when the recording has no schedule for it. */
function scheduleFromBoard(board, reg) {
  const { airport } = board;
  const here = { code: airport.code, name: airport.name };
  const time = f => ({ ts: f.ts, local: f.local, schedTs: f.schedTs, schedLocal: f.schedLocal, tz: airport.tz,
                       kind: f.actual ? "actual" : f.estimated ? "estimated" : "scheduled" });
  const none = { ts: null, local: "", kind: "" };
  return board.flights.filter(f => normReg(f.reg) === normReg(reg)).map(f => {
    const away = { code: f.other, name: f.otherName };
    const arriving = f.dir === "arr";
    return {
      number: f.number, airlineName: f.airlineName, model: f.model,
      origin: arriving ? away : here,
      dest: arriving ? here : away,
      dep: arriving ? none : time(f),
      arr: arriving ? time(f) : none,
      state: f.actual ? (arriving ? "Landed" : "Departed") : f.estimated ? "Expected" : "Scheduled",
    };
  });
}

/** Data for the static demo: a recorded moment if demo-data.json exists, else a made-up sample. */
export async function demoSource() {
  const recorded = await loadRecording();
  if (recorded) startClockAt(recorded.recordedAt);
  const recording = recorded || sampleRecording();
  const code = recording.board.airport.code;
  let prefs = { types: [], direction: "both" };

  const findEntry = reg => recording.registry.find(e => normReg(e.reg) === normReg(reg));
  const recordedSchedule = reg =>
    Object.entries(recording.tails || {}).find(([r]) => normReg(r) === normReg(reg))?.[1];

  return {
    isDemo: true,
    recording: recorded ? { airport: recording.board.airport, recordedAt: recording.recordedAt } : null,
    airportCode: code,

    summary: async () => ({ registry: recording.registry, prefs, database: { state: "ok", message: "" } }),
    importStatus: async () => ({ state: "ok", message: "" }),
    savePrefs: async next => { prefs = next; },

    async board(airport) {
      if (airport !== code) throw new Error(`The demo only has data for ${code}. Run Livery Watch yourself for any airport.`);
      return { ...recording.board, fetchedAt: nowSeconds() };
    },
    live: async () => recording.live,

    async tail(raw) {
      const reg = raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
      if (!reg) throw new Error("Enter a tail number, like JA894A or N933AK.");
      const entry = findEntry(reg);
      if (!entry) return { special: false, reg };
      const schedule = recordedSchedule(reg);
      return {
        special: true,
        reg: entry.reg,
        entry,
        flights: schedule || scheduleFromBoard(recording.board, reg),
        partial: !schedule,
      };
    },
  };
}
