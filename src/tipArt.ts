/**
 * Small line drawings for tooltips (`data-tip-art="<key>"` next to `data-tip`). Each is 240 × 90,
 * usually two panels side by side with a caption under each. Colours come from classes styled in
 * style.css, so they follow the tooltip's own light or dark colours:
 * m = plywood, p = a part, c = the bit's path, d = dashed guide, bit = the bit, cap = caption.
 */
const svg = (body: string) =>
  `<svg class="tipArt" viewBox="0 0 240 90" aria-hidden="true">${body}</svg>`;
const cap = (x: number, text: string) => `<text class="cap" x="${x}" y="85" text-anchor="middle">${text}</text>`;

export const TIP_ART: Record<string, string> = {
  // A slot's inside corners: the round bit leaves a radius a square tab can't pass; dogbones cut it away.
  dogbone: svg(`
    <path class="m" d="M10 10H40V39Q40 45 46 45H69Q75 45 75 39V10H105V70H10Z"/>
    <rect class="d" x="40" y="4" width="35" height="41"/>
    <path class="c" d="M37 41L43 47M78 41L72 47"/>
    ${cap(57, 'Rounded: tab sits high')}
    <path class="m" d="M135 10H165V37.93A5 5 0 1 0 172.07 45H192.93A5 5 0 1 0 200 37.93V10H230V70H135Z"/>
    <rect class="d" x="165" y="4" width="35" height="41"/>
    ${cap(182, 'Dogbones: tab seats')}`),

  // Actual shape lets a small part sit in a notch; the hull packs the part as its outline.
  hull: svg(`
    <path class="p" d="M15 12H100V64H72V36H43V64H15Z"/>
    <rect class="p" x="49" y="44" width="17" height="20"/>
    ${cap(57, 'Actual shape: parts nest')}
    <path class="p" d="M130 12H215V64H187V36H158V64H130Z"/>
    <rect class="d" x="126" y="8" width="93" height="60"/>
    ${cap(172, 'Convex hull: no nesting')}`),

  // Common-line cutting: neighbours one bit apart share a single pass.
  share: svg(`
    <rect class="p" x="16" y="22" width="38" height="38"/><rect class="p" x="68" y="22" width="38" height="38"/>
    <rect class="c" x="12" y="18" width="46" height="46"/><rect class="c" x="64" y="18" width="46" height="46"/>
    ${cap(61, 'Separate cuts')}
    <rect class="p" x="134" y="22" width="38" height="38"/><rect class="p" x="178" y="22" width="38" height="38"/>
    <rect class="c" x="130" y="18" width="90" height="46"/><path class="c" d="M175 18V64"/>
    ${cap(175, 'One shared cut between')}`),

  // Where the packed block sits on the sheet.
  center: svg(`
    <rect class="m" x="10" y="8" width="100" height="62"/>
    <rect class="p" x="15" y="45" width="30" height="20"/><rect class="p" x="48" y="50" width="22" height="15"/><rect class="p" x="15" y="30" width="20" height="12"/>
    ${cap(60, 'Packed into a corner')}
    <rect class="m" x="130" y="8" width="100" height="62"/>
    <rect class="p" x="154" y="34" width="30" height="20"/><rect class="p" x="187" y="39" width="22" height="15"/><rect class="p" x="154" y="19" width="20" height="12"/>
    ${cap(180, 'Moved to the middle')}`),

  // Parts sit one outline-bit width apart.
  bit: svg(`
    <rect class="p" x="34" y="20" width="76" height="46"/><rect class="p" x="130" y="20" width="76" height="46"/>
    <circle class="bit" cx="120" cy="43" r="10"/>
    <path class="d" d="M110 14V72M130 14V72"/>
    ${cap(120, 'Gap between parts = bit width')}`),

  // Uncut bridges hold the part in the sheet during the last pass.
  tabs: svg(`
    <rect class="p" x="30" y="20" width="180" height="40"/>
    <path class="c" d="M90 16H150M160 16H214V64H125M115 64H26V16H80"/>
    <rect class="m" x="80" y="13" width="10" height="6"/><rect class="m" x="150" y="13" width="10" height="6"/><rect class="m" x="115" y="61" width="10" height="6"/>
    ${cap(120, 'Short uncut bridges hold the part')}`),

  // Side view of the stock: straight plunge versus easing in along the path.
  ramp: svg(`
    <rect class="m" x="10" y="30" width="100" height="36"/>
    <path class="c" d="M25 8V54H100"/>
    ${cap(60, 'Plunge straight down')}
    <rect class="m" x="130" y="30" width="100" height="36"/>
    <path class="c" d="M140 8V30L185 54H225"/>
    ${cap(180, 'Ramp in along the path')}`),

  // Side view: the through cut goes a little past the bottom of the stock.
  depth: svg(`
    <rect class="m" x="20" y="18" width="200" height="38"/>
    <path class="d" d="M20 64H220"/>
    <path class="c" d="M120 6V64"/>
    <text class="cap" x="126" y="70">extra</text>
    ${cap(120, 'Cut goes below the stock so parts come free')}`),

  // Side view: the same path, lifted clear of the stock.
  air: svg(`
    <rect class="m" x="20" y="44" width="200" height="26"/>
    <path class="d" d="M60 30V62H180V30"/>
    <path class="c" d="M60 4V22H180V4"/>
    <path class="d" d="M200 22V44"/><text class="cap" x="204" y="37">lift</text>
    ${cap(120, 'The whole job runs above the material')}`),

  // Top view: the bit waits over the stock's lower-left corner.
  bounds: svg(`
    <rect class="m" x="20" y="6" width="200" height="66"/>
    <rect class="p" x="44" y="16" width="56" height="30"/><rect class="p" x="108" y="16" width="44" height="46"/>
    <path class="d" d="M20 72L60 40"/>
    <circle class="bit" cx="20" cy="72" r="5"/>
    ${cap(120, 'The bit stops over the stock\'s corner')}`),

  // Top view: the pen draws a bracket at the stock's left edge.
  penBounds: svg(`
    <rect class="d" x="20" y="6" width="200" height="66"/>
    <rect class="p" x="44" y="16" width="56" height="30"/><rect class="p" x="108" y="16" width="44" height="46"/>
    <path class="c" d="M60 6H20V72H60"/>
    <path class="bit" d="M60 72l14-22 6 4-14 22-7 3z"/>
    ${cap(120, 'A pen line along the stock\'s left edge')}`),

  // Manual cut: the saw blade takes a strip of wood between neighbours.
  kerf: svg(`
    <rect class="p" x="22" y="20" width="86" height="46"/><rect class="p" x="132" y="20" width="86" height="46"/>
    <rect class="bit" x="112" y="12" width="16" height="62"/>
    ${cap(120, 'The blade turns this much wood to dust')}`),

  // Extra room on top of the blade width.
  gap: svg(`
    <rect class="p" x="10" y="20" width="46" height="46"/><rect class="p" x="64" y="20" width="46" height="46"/>
    <rect class="bit" x="56" y="14" width="8" height="58"/>
    ${cap(60, 'Blade width only')}
    <rect class="p" x="130" y="20" width="40" height="46"/><rect class="p" x="190" y="20" width="40" height="46"/>
    <rect class="bit" x="176" y="14" width="8" height="58"/>
    <path class="d" d="M170 10V76M190 10V76"/>
    ${cap(180, 'Plus room for error')}`),

  // Numbered cuts, each running edge to edge across the piece in hand.
  through: svg(`
    <rect class="m" x="20" y="6" width="200" height="66"/>
    <rect class="p" x="26" y="12" width="78" height="24"/><rect class="p" x="26" y="46" width="78" height="20"/><rect class="p" x="118" y="12" width="96" height="54"/>
    <path class="c" d="M111 6V72M20 41H111"/>
    <circle class="bit" cx="111" cy="22" r="6"/><text class="cap" x="111" y="25" text-anchor="middle">1</text>
    <circle class="bit" cx="64" cy="41" r="6"/><text class="cap" x="64" y="44" text-anchor="middle">2</text>
    ${cap(120, 'Numbered cuts, each edge to edge')}`),

  // A slot cut wider by the allowance so the tab slides in.
  fit: svg(`
    <path class="m" d="M10 14H45V50H75V14H110V70H10Z"/>
    <rect class="d" x="45" y="6" width="30" height="44"/>
    ${cap(60, 'Exact size: tight fit')}
    <path class="m" d="M130 14H162V50H198V14H230V70H130Z"/>
    <rect class="d" x="165" y="6" width="30" height="44"/>
    ${cap(180, 'With allowance: slides in')}`),
};
