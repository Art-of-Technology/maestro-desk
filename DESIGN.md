# Respovia — White & Violet

Approved theme: 15 September 2026. This replaces the garden theme.

## Palette

| Role | Colour | CSS token |
| --- | --- | --- |
| Page canvas | #F5F0FF | --w |
| Cards, sidebar, forms and email body | #FFFFFF | --off |
| Secondary surfaces | #EEE6FC | --off2 |
| Actions and selected controls | #6D28D9 | --purple / --cta |
| Hovered primary action | #5B21B6 | --cta-hover |
| Selection and agent reply highlight | #F0E8FF | --purple-lt |
| Main text | #201238 | --ink |
| Secondary text | #493B60 | --ink2 |
| Muted text | #685A7C | --ink3 |
| Placeholder text | #716185 | --ink4 |
| Small brand accent | #F5C400 | --gold |

## Interface

- White content on a soft lavender canvas. No garden shapes or decorative animations.
- Inter for headings and body; DM Mono for compact identifiers and numeric utilities.
- Retain the existing layout, responsive behaviour, density and rounded controls.
- Violet marks actions, active tabs, selected navigation and keyboard focus.
- Primary buttons have white text on violet. Secondary actions are outlined.
- Customer messages are white; agent replies have a pale lavender fill and violet edge.
- Internal notes use amber. Open tickets use blue, resolved green, escalation magenta, and urgent/error red. Status text always accompanies colour.
- Keep semantic colours independent of workspace accents. The portal mirrors status tokens.
- Uploaded workspace logos and explicitly configured primary colours remain supported. Custom primary colours override navigation accents as before; primary action buttons and email styling use the theme palette.
- Use shared tokens rather than literal colours in feature components. Legacy token names remain for compatibility.

## Email

The outgoing shell and Settings preview use inline solid colours: lavender outer canvas, white card and header, dark ink body, violet links and white-on-violet action buttons. Use system sans-serif fonts; do not depend on webfonts, CSS variables or alpha compositing in mail clients. Keep configured headers, footers, signatures, logos, rich content and plain-text alternatives intact.

## Validation

Check dashboard, ticket list, open ticket, composer focus, settings preview, sign-in and portal at desktop and narrow widths. Measure text contrast on all theme surfaces, including status badges. Run frontend build, route/detail smokes, collision/import audits, API typecheck and relevant email tests before review.
