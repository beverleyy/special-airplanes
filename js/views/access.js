import { escapeHtml } from "../format.js";

const DEFAULT_REASON = "The live version is shared by invitation, because the free flight data sources it uses are for personal use.";

/** The card that asks for an access code, with an optional error from the last try. */
export function accessCardHtml({ reason = DEFAULT_REASON, error = "" } = {}) {
  return `<section class="access-card" aria-labelledby="access-title">
    <div class="access-card__head">
      <span class="access-card__badge">Live</span>
      <h2 class="access-card__title" id="access-title">Enter your access code</h2>
    </div>
    <div class="access-card__body">
      <p class="access-card__intro">${escapeHtml(reason)} If you were sent an access link, opening it skips this step.</p>
      <form class="access-card__form" id="access-form" novalidate>
        <label class="field access-card__field">
          <span class="field__label">Access code</span>
          <span class="access-card__input">
            <input class="field__input" id="access-code" name="code" type="password" autocomplete="current-password"
                   autocapitalize="off" spellcheck="false" aria-describedby="access-error">
            <button class="access-card__reveal" type="button" data-action="toggle-code" aria-pressed="false">Show</button>
          </span>
        </label>
        <button class="btn btn--primary" id="access-submit" type="submit">Unlock live data</button>
      </form>
      <p class="access-card__error" id="access-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error)}</p>
      <p class="access-card__alt">No code? <button class="link-button" type="button" data-mode="demo">Try the demo</button>:
        a recorded moment at a real airport, with everything else working the same.</p>
    </div>
  </section>`;
}

/** Demo / Live switch for the toolbar, plus a way to forget a saved code on shared computers. */
export function modeSwitchHtml(mode, { unlocked = false } = {}) {
  const option = (value, label) =>
    `<button class="mode-switch__option" type="button" data-mode="${value}" aria-pressed="${mode === value}">${label}</button>`;
  const forget = mode === "live" && unlocked
    ? `<button class="link-button mode-switch__forget" type="button" data-action="forget-code">Forget code</button>`
    : "";
  return `<span class="mode-switch__group" role="group" aria-label="Data">${option("demo", "Demo")}${option("live", "Live")}</span>${forget}`;
}
