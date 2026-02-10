// Keep interactive performance/stability sane on typical laptops.
// (The app has an experimental >=200k GPU pipeline, but many devices will struggle or show artifacts.)
export const MAX_PARTICLE_DENSITY = 1300000;

// Built-in demo asset so the "Try demo sequence" button works even when the page
// is opened via file:// (where fetch() of local files is commonly blocked).
export const BUILTIN_TEST_LOGO_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#e8e8ed"/>
  <path d="M35 35 L65 35 L50 70 Z" fill="#0a0a0f"/>
  <circle cx="50" cy="25" r="8" fill="#0a0a0f"/>
</svg>`;
