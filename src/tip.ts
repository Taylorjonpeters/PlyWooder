/**
 * Help text: an ⓘ next to a label, or any element with a `data-tip` attribute, shows that text in one
 * floating bubble on hover or keyboard focus. The bubble is positioned in viewport coordinates, so
 * scrolling panels never clip it. Use this instead of the native `title` attribute.
 * Add `data-tip-art="<key>"` to show one of the drawings in tipArt.ts above the text.
 */
import { TIP_ART } from './tipArt';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Markup for an ⓘ that explains `text`, optionally with a drawing from tipArt.ts. */
export const tip = (text: string, art?: string) =>
  `<span class="tip" tabindex="0" role="img" aria-label="${esc(text)}" data-tip="${esc(text)}"${art ? ` data-tip-art="${art}"` : ''}>i</span>`;

export function initTips() {
  const bubble = document.createElement('div');
  bubble.className = 'tipBubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.appendChild(bubble);

  const show = (el: HTMLElement) => {
    const art = el.dataset.tipArt ? TIP_ART[el.dataset.tipArt] : undefined;
    if (art) bubble.innerHTML = `${art}<span>${esc(el.dataset.tip ?? '')}</span>`;
    else bubble.textContent = el.dataset.tip ?? '';
    bubble.classList.toggle('hasArt', !!art);
    bubble.hidden = false;
    const r = el.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - margin);
    const below = r.bottom + 6;
    const top = below + b.height > window.innerHeight - margin ? r.top - b.height - 6 : below;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  };
  const hide = () => { bubble.hidden = true; };
  const target = (e: Event) => (e.target as HTMLElement).closest?.<HTMLElement>('[data-tip]');

  document.addEventListener('mouseover', (e) => { const t = target(e); if (t) show(t); });
  document.addEventListener('mouseout', (e) => { if (target(e)) hide(); });
  document.addEventListener('focusin', (e) => { const t = target(e); if (t) show(t); });
  document.addEventListener('focusout', (e) => { if (target(e)) hide(); });
  // A tip sits inside its label; a click on it must not toggle or focus the label's control.
  document.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest?.<HTMLElement>('.tip[data-tip]');
    if (t) { e.preventDefault(); show(t); }
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
