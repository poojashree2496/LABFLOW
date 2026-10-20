# Site themes

LABFLOW ships ten site themes. The super admin picks one and it applies to **every user, the kiosks and the sign-in screen**. There is no per-user theme.

## Pick a theme

Admin > Settings > Appearance > `uiTheme`, choose a value and save. The change is audited. Phones and kiosks pick it up on their next load; a device remembers the last theme it saw (`lf-skin` in local storage) so the page does not flash the default first. The hosted sign-in screen asks the server for the theme (`ui.theme`, the one call that needs no session) so it wears the same theme before anyone signs in.

Only the active theme's fonts are fetched from Google Fonts.

## What each theme changes

A theme changes the colours, type, shapes **and** the layout of the shell. Layout is either `sidebar` (menu on the left) or `topnav` (menu across the top). Some add a profile banner (hero), a decorative layer or a footer.

| Id | Name | Layout | Character |
|---|---|---|---|
| `karunya` (default) | Karunya | sidebar, collapsible | University portal look: white sidebar, blue current-page pill, profile banner with the signed-in person's roll number and department |
| `neo-brutalism` | Neo-brutalism | topnav | Cream background, Lexend, a row of coloured dots in the footer |
| `pixel-art` | Pixel art | sidebar | Dark background, pixel fonts (Silkscreen, Pixelify Sans), a "Press start" footer |
| `wabi-sabi` | Wabi-sabi | topnav | Warm paper background, serif type (Cormorant Garamond), a decorative layer with a sun and wood rings |
| `cybercore` | Cybercore | topnav | Grey grid-and-blob banner with the date and time, Unbounded and IBM Plex Mono |
| `maximal-library` | Maximal library | sidebar | White background, bold headings (Anton, Archivo Black) |
| `scrapbook` | Scrapbook | topnav | Cream paper background, decorative layer, hand-kept footer |
| `post-internet` | Post-internet | sidebar | Near-black background |
| `luxury-type` | Luxury type | topnav | Light grey background |
| `bohemian` | Bohemian | topnav | Dark green-black background |

Screenshots of the student and admin screens in `karunya`, `neo-brutalism` and `cybercore` are in [`docs/screens/themes/`](screens/themes/).

**What a theme never touches:** the QR codes and the camera preview stay black on white at full size so they always scan.

## How it works

- **`styles/themes/<id>.css`** holds the look. Every rule is under `:root[data-skin="<id>"]` (the colour tokens such as `--paper`, `--ink`, `--accent`, then any shape changes).
- **`styles/input.css`** `@import`s each theme file; `npm run build:css` compiles them with Tailwind into `src/Styles.html`.
- **`src/ScriptsThemes.html`** has the registry, `LF.SKINS`. An entry gives the label, `layout`, the browser bar colour, the Google Fonts URL, optional `collapse`, and optional `hero(me, role)`, `decor()` and `foot()` functions that build extra blocks for the shell.
- **`LF.applySkin(id)`** sets `data-skin` on `<html>`, loads only that theme's fonts and sets the browser bar colour. The shell reads the layout from `LF.skin()`.
- **`Cfg.SETTINGS.uiTheme`** (in `src/Config.gs`) is an enum of the allowed ids.

## Add a theme

1. Create `styles/themes/<id>.css`. Start from `karunya.css`: copy the `:root[data-skin="karunya"]` token block, rename it, change the values, then add any layout or shape rules, all under `[data-skin="<id>"]`.
2. Add `@import "./themes/<id>.css";` to `styles/input.css`.
3. Add an entry to `LF.SKINS` in `src/ScriptsThemes.html` (`label`, `layout`, `color`, `fonts`, and optionally `hero`, `decor`, `foot`).
4. Add the id to the `values` list of `uiTheme` in `src/Config.gs`.
5. Run `npm run build:css`, then `npm run check`. The test "every selectable theme has its registry entry and its stylesheet" fails if step 2, 3 or 4 is missing.
6. Check it on a real phone, and scan the kiosk QR under it (TEST_PLAN, deployment check 9). Text on the accent colour should keep WCAG AA contrast.

Do not restyle the QR canvas or the video preview, and keep tap targets at least 44 px on the phone layout.
