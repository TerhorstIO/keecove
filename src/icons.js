const paths = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4m-4 4v2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 3 3m-1-5 3 3"/>',
  shield: '<path d="M12 22s7-3.5 7-9V5l-7-3-7 3v8c0 5.5 7 9 7 9z"/><path d="m9 12 2 2 4-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 8a8 8 0 0 0-14-2L3 9m0 0V4m0 5h5m-4 7a8 8 0 0 0 14 2l3-3m0 0v5m0-5h-5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  edit: '<path d="m13 6 5 5M4 20l4-1L21 6l-4-4L4 15z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.3"/>',
  eyeOff: '<path d="m3 3 18 18M10 6c.6-.1 1.3 0 2 0 6.5 0 10 6 10 6a17 17 0 0 1-3 3.3M6 7.6C3.5 9.3 2 12 2 12s3.5 6 10 6c1.2 0 2.4-.2 3.4-.6"/>',
  puzzle: '<path d="M4 5h5a3 3 0 1 1 6 0h5v5a3 3 0 1 0 0 6v4h-5a3 3 0 1 0-6 0H4v-5a3 3 0 1 0 0-6z"/>',
  file: '<path d="M7 3h7l4 4v14H6V3zm7 0v5h4m-9 5h6m-6 4h6"/>',
  spark: '<path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2zm7 14v6m-3-3h6"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>'
};

export function icon(name, size = 18) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
