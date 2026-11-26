/**
 * The version shown in the header, and the What's new modal. The modal opens once after an
 * update, and any time from the version link. A first visit doesn't open it: there is nothing
 * new to someone who hasn't used the app before.
 */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;

export const APP_VERSION = __APP_VERSION__;
const BUILD = __APP_BUILD__;

/** Newest first. Keep each line short: what changed, in the words the app uses. */
const CHANGELOG: { version: string; items: [string, string][] }[] = [
  {
    version: '0.2.0',
    items: [
      ['GORDIX faces north.', 'Every sheet is drawn as it sits on the machine, with the GORDIX pointing up.'],
      ['Swap X and Y.', 'A button by the sheet size turns the sheet on the machine.'],
      ['True GORDIX range.', "Reach uses the machine's own limit rule, so files that fit here load on the machine."],
      ['Reach warnings.', 'A warning shows when the stock edge is out of reach, or Z leaves −30 to +3 mm.'],
      ['Pen bounds.', 'The pen draws only the edges it can reach.'],
      ['Air cut on GORDIX.', 'It runs at the safe height.'],
      ['Autosave.', 'Your work saves as you go. You can also save a project to a file.'],
      ['Save dialogs.', 'Downloads open a Save dialog. Several files go into one folder you pick.'],
      ['File names.', 'Bounds files start with bounds_ so they sort together.'],
      ['Fix.', 'The sheet size no longer resets when the page loads.'],
    ],
  },
  {
    version: '0.1',
    items: [['First release.', 'Nesting for saw and CNC, a GORDIX G-code workspace, the bit library, DXF import and Suggest size.']],
  },
];

const SEEN = 'plywooder.seenVersion';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const versionLabel = () => `v${APP_VERSION}${BUILD ? ` · ${BUILD}` : ''}`;

export const showWhatsNew = () => {
  if (document.getElementById('whatsNew')) return;
  try { localStorage.setItem(SEEN, APP_VERSION); } catch { /* storage unavailable */ }
  const root = document.createElement('div');
  root.className = 'modal';
  root.id = 'whatsNew';
  root.innerHTML = `<div class="modalBox supportBox whatsNewBox" role="dialog" aria-modal="true" aria-labelledby="whatsNewTitle">
      <header class="modalHead"><h2 id="whatsNewTitle">What's new</h2><span class="hint">${esc(versionLabel())}</span></header>
      <div class="supportBody">
        ${CHANGELOG.map((r) => `<section><h3>v${esc(r.version)}</h3><ul>${r.items.map(([b, t]) => `<li><b>${esc(b)}</b> ${esc(t)}</li>`).join('')}</ul></section>`).join('')}
      </div>
      <footer class="modalFoot"><span></span><button class="primary" type="button">Got it</button></footer>
    </div>`;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); root.remove(); };
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  root.querySelector('button')!.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(root);
  root.querySelector('button')!.focus();
};

/**
 * Open What's new once for a returning visitor on a new version. `returning` says whether this
 * browser has used the app before (saved settings exist).
 */
export const whatsNewOnUpdate = (returning: boolean) => {
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN); } catch { return; }
  if (seen === APP_VERSION) return;
  if (!returning) { try { localStorage.setItem(SEEN, APP_VERSION); } catch { /* storage unavailable */ } return; }
  showWhatsNew();
};
