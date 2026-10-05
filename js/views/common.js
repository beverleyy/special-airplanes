import { escapeHtml } from "../format.js";

export const holdSign = message => `<span class="sign sign--hold">${escapeHtml(message)}</span>`;

export const progress = message => `<span class="progress">${escapeHtml(message)}</span>`;

export const fact = (label, valueHtml) =>
  `<div class="fact"><span class="label">${escapeHtml(label)}</span><span class="value">${valueHtml}</span></div>`;

export function chip({ label, name, value, pressed, count }) {
  const counter = count == null ? "" : `<span class="chip__count">${count}</span>`;
  return `<button class="chip" type="button" data-${name}="${escapeHtml(value)}" aria-pressed="${pressed}">`
    + `${escapeHtml(label)}${counter}</button>`;
}

export const chipRowLabel = text => `<span class="chip-row__label">${escapeHtml(text)}</span>`;
