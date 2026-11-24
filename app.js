(() => {
  const root = document.documentElement;
  root.classList.add('js');

  const themeButton = document.querySelector('#theme-toggle');
  function updateThemeLabel() {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
  }
  updateThemeLabel();
  themeButton.addEventListener('click', () => {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 450);
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

  // Active nav indicator + header scroll progress hairline
  const navLinks = [...menu.querySelectorAll('a')];
  const sections = navLinks.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const progressBar = document.querySelector('#scroll-progress-bar');
  let scrollPending = false;
  function onScrollFrame() {
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 170) current = section;
    }
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (window.scrollY >= maxScroll - 8) current = sections.at(-1);
    navLinks.forEach(link => {
      if (link.hash === '#' + current.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    if (progressBar) {
      const pct = Math.max(0, Math.min(100, (window.scrollY / maxScroll) * 100));
      progressBar.style.transform = `scaleX(${pct / 100})`;
    }
    scrollPending = false;
  }
  window.addEventListener('scroll', () => {
    if (!scrollPending) { scrollPending = true; requestAnimationFrame(onScrollFrame); }
  }, { passive: true });
  onScrollFrame();

  // Subtle section reveal on scroll (progressive enhancement)
  const revealEls = [...document.querySelectorAll('.reveal')];
  if (revealEls.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const ro = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          ro.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -28px 0px' });
    revealEls.forEach(el => ro.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('is-visible'));
  }

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
      selection.removeAllRanges();
      selection.addRange(range);
      notify('Email selected. Press Ctrl+C or ⌘C to copy.');
    }
  });
})();
