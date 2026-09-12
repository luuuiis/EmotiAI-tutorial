  // toggle mobile nav
  const sideNav = document.getElementById('sideNav');
  document.getElementById('mobileToggle').addEventListener('click', () => {
    sideNav.classList.toggle('open');
  });

  // scrollspy
  const links = Array.from(document.querySelectorAll('nav.side a[href^="#"]'));
  const sections = links.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);

  const setActive = (id) => {
    links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) setActive(entry.target.id);
    });
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });

  sections.forEach(s => observer.observe(s));

  links.forEach(a => a.addEventListener('click', () => {
    sideNav.classList.remove('open');
  }));
