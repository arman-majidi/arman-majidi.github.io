(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector('#theme-toggle');
  function updateThemeLabel() {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
  }
  updateThemeLabel();
  themeButton.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('arman-theme', root.dataset.theme); } catch (_) {}
    updateThemeLabel();
  });

  const menu = document.querySelector('#main-nav');
  const menuButton = document.querySelector('#menu-toggle');
  function closeMenu() {
    menu.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open navigation');
  }
  menuButton.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.classList.contains('open')) { closeMenu(); menuButton.focus(); }
  });
  matchMedia('(min-width: 801px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  const navLinks = [...menu.querySelectorAll('a')];
  const sections = navLinks.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  let scrollPending = false;
  function markCurrentSection() {
    let current = sections[0];
    for (const section of sections) { if (section.getBoundingClientRect().top <= 170) current = section; }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) current = sections.at(-1);
    navLinks.forEach(link => {
      if (link.hash === '#' + current.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    scrollPending = false;
  }
  window.addEventListener('scroll', () => {
    if (!scrollPending) { scrollPending = true; requestAnimationFrame(markCurrentSection); }
  }, {passive: true});
  markCurrentSection();
  document.querySelector('#year').textContent = new Date().getFullYear();

  const toast = document.querySelector('#toast');
  let toastTimer;
  function notify(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4500);
  }
  document.querySelector('#copy-email').addEventListener('click', async () => {
    const email = 'arman.majidi.2003@gmail.com';
    try {
      await navigator.clipboard.writeText(email);
      notify('Email address copied.');
    } catch (_) {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.email-chip span'));
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      notify('Email selected. Press Ctrl+C or ⌘C to copy.');
    }
  });
})();
