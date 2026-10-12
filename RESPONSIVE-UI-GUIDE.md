# Trifolia V60 Responsive UI Update

## Goal
Improve the existing Trifolia Management System layout across mobile phones, tablets, laptops, and desktop screens without removing the existing modules or changing business workflows.

## Changes
- Added a responsive UI layer in `src/styles.css` for screen widths: small phones (<=380px), phones (<=640px), tablets (641–1024px), and landscape mobile devices.
- Prevented document-level horizontal overflow and constrained content/media to the viewport.
- Improved touch target sizes and mobile input font sizing to reduce accidental taps and unwanted browser zoom.
- Made page headers and action bars wrap on narrow screens.
- Kept wide data tables inside their own horizontally scrollable container so they do not force the entire page wider than the screen.
- Adjusted forms, dashboard cards, filters, report buttons, login/role selection, and modal dialogs for smaller screens.
- Improved modal scrolling for short landscape screens and mobile incident-report previews.
- Added reduced-motion support.

## Validation status
- CSS brace-balance static check: passed.
- Existing Node.js syntax checks: previously passed for the server and password-reset script.
- Dependency installation: timed out in this environment.
- Production Vite build: not verified.
- Browser/device tests: not yet run.

## Required before release
Run `npm install` in a trusted environment, then `npm run build`. Test the system at widths of 320, 360, 390, 430, 768, 820, 1024, 1280 and 1440 CSS pixels. Confirm the page itself has no horizontal scrolling; data tables may scroll within their own containers. Test all forms and dialogs in portrait and landscape, and test with Android Chrome and iPad Safari. This UI change does not itself certify the application as secure for public hosting.
