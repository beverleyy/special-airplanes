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

export function accessFormHtml(message) {
  return `<form class="access" id="access-form">
    <p class="access__message">${escapeHtml(message)}</p>
    <label class="field">
      <span class="field__label">Access code</span>
      <input class="field__input" id="access-code" type="password" autocomplete="current-password" required>
    </label>
    <button class="btn" type="submit">Unlock</button>
    <a class="access__demo" href="?demo">Or view the demo</a>
  </form>`;
}

export const chipRowLabel = text => `<span class="chip-row__label">${escapeHtml(text)}</span>`;
