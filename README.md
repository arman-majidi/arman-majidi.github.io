# Arman Majidi — Personal Academic Website

A buildless academic website with a personal introduction, research sketches, education, teaching, tools and contact details. The current public repository was used as the starting point for this revision, including its portrait, CV and academic information.

## Editing

- `index.html` — personal and academic content.
- `styles.css` — layout, typography, responsive design and both themes.
- `app.js` — navigation, theme selection and email copying.
- `signals.js` — two research illustrations.
- `theme.js` — applies the saved theme before rendering.
- `assets/` — original portrait and CV, local SVG icons.

No packages or build command are required. The site works from a static host, including GitHub Pages. The exported ZIP places the website files at the repository root.

## Research illustrations

The first illustration uses three synthetic sources and two instantaneous linear mixtures. Source toggles and a gain control update both mixtures. The frequency view computes a one-sided DFT from the same 256-sample signals. It is an explanation of mixing, not an implementation or evaluation of speech separation. The figure explicitly labels this distinction.

The second illustration shows three synthetic accelerometer traces and the conceptual sensor-to-CNN pipeline. Axis buttons highlight one trace. Neither figure contains experimental recordings, accuracy claims or model predictions.

Waveform motion can be paused. It stops offscreen and in hidden tabs, and is paused by default when reduced motion is requested. No audio or microphone access is used. Assets and application code are local; no analytics or external runtime dependencies are added.

## Validation

Browser checks covered desktop light/dark themes; 390, 320 and 540 px iframe viewports; mobile navigation; source toggles; all sources silent; the single-source RMS case; frequency view; source gain; reset; accelerometer axis highlighting; coursework and teaching disclosures. No horizontal overflow or broken images was observed in those checks. Static checks cover JavaScript syntax, local references, unique IDs and unchanged portrait/CV bytes.

See `GITHUB_PAGES_FA.md` for the update procedure. Existing repository licenses remain in `THIRD_PARTY_NOTICES.md` and the exported `THIRD_PARTY_NOTICES.txt`.
