(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector('#theme-toggle');
  const updateThemeLabel = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
  };
  updateThemeLabel();

  themeButton.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('arman-theme', root.dataset.theme);
    } catch (e) {}
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.classList.contains('open')) {
      closeMenu();
      menuButton.focus();
    }
  });

  window.matchMedia('(min-width: 721px)').addEventListener('change', e => {
    if (e.matches) closeMenu();
  });

  const navLinks = [...menu.querySelectorAll('a')];
  const sections = navLinks.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          navLinks.forEach(a => {
            if (a.getAttribute('href') === '#' + entry.target.id) {
              a.setAttribute('aria-current', 'location');
            } else {
              a.removeAttribute('aria-current');
            }
          });
        }
      }
    }, { rootMargin: '-15% 0px -65% 0px' });
    sections.forEach(s => observer.observe(s));
  }

  const yearEl = document.querySelector('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const toast = document.querySelector('#toast');
  let toastTimer;
  function notify(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  const copyBtn = document.querySelector('#copy-email');
  copyBtn.addEventListener('click', async () => {
    const email = 'arman.majidi.2003@gmail.com';
    try {
      await navigator.clipboard.writeText(email);
      notify('Email address copied to clipboard.');
    } catch (e) {
      const temp = document.createElement('textarea');
      temp.value = email;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      try {
        document.execCommand('copy');
        notify('Email address copied to clipboard.');
      } catch (err) {
        notify('Email: ' + email);
      }
      document.body.removeChild(temp);
    }
  });
})();
