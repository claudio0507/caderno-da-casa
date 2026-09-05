/* Aplica o tema salvo antes do CSS carregar, para não piscar. */
try { if (localStorage.getItem('caderno-da-casa:theme') === 'light') document.documentElement.setAttribute('data-theme', 'light'); } catch (e) { /* sem localStorage */ }
