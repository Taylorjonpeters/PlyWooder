/**
 * Info tooltips: an ⓘ next to a label, showing its `data-tip` text on hover or keyboard focus.
 * One floating bubble positioned in viewport coordinates, so scrolling panels never clip it.
 */
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Markup for an ⓘ that explains `text`. */
export const tip = (text: string) => `<span class="tip" tabindex="0" role="img" aria-label="${esc(text)}" data-tip="${esc(text)}">i</span>`;

export function initTips() {
  const bubble = document.createElement('div');
  bubble.className = 'tipBubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.appendChild(bubble);

  const show = (el: HTMLElement) => {
    bubble.textContent = el.dataset.tip ?? '';
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
  const target = (e: Event) => (e.target as HTMLElement).closest?.<HTMLElement>('.tip[data-tip]');

  document.addEventListener('mouseover', (e) => { const t = target(e); if (t) show(t); });
  document.addEventListener('mouseout', (e) => { if (target(e)) hide(); });
  document.addEventListener('focusin', (e) => { const t = target(e); if (t) show(t); });
  document.addEventListener('focusout', (e) => { if (target(e)) hide(); });
  // A tip sits inside its label; a click on it must not toggle or focus the label's control.
  document.addEventListener('click', (e) => { const t = target(e); if (t) { e.preventDefault(); show(t); } });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
