(() => {
  let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try {
    const saved = localStorage.getItem('arman-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
})();
