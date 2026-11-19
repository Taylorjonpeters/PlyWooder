/**
 * Icons: the sprite lives in index.html (`<symbol id="i-play">` and so on). Use `icon('play')` in
 * generated markup; static markup can use `<svg class="ico"><use href="#i-play"/></svg>` directly.
 * They draw in currentColor and scale with the text around them.
 */
export type IconName = 'play' | 'pause' | 'close' | 'arrow' | 'plus';

export const icon = (name: IconName) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/** Show the play or pause icon on a player button, and keep its accessible name in step. */
export function setPlayState(btn: HTMLElement, playing: boolean) {
  btn.innerHTML = icon(playing ? 'pause' : 'play');
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
