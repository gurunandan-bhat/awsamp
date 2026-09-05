// Module 01: plain DOM manipulation, no framework, no bundler-specific magic.
// This is also the spot where Module 02 will import `aws-amplify/auth`.

const toggleButton = document.getElementById('toggle-status');
const statusPanel = document.getElementById('status');

const buildInfo = {
  module: 'Module 01 — Static site',
  builtWith: 'Vite (vanilla JS, no framework)',
  deployedVia: 'AWS Amplify Hosting',
};

function renderStatus() {
  statusPanel.innerHTML = `
    <dl>
      <dt>Current module</dt><dd>${buildInfo.module}</dd>
      <dt>Built with</dt><dd>${buildInfo.builtWith}</dd>
      <dt>Deployed via</dt><dd>${buildInfo.deployedVia}</dd>
    </dl>
  `;
}

toggleButton.addEventListener('click', () => {
  const isHidden = statusPanel.hidden;

  if (isHidden && statusPanel.childElementCount === 0) {
    renderStatus();
  }

  statusPanel.hidden = !isHidden;
  toggleButton.setAttribute('aria-expanded', String(isHidden));
  toggleButton.textContent = isHidden ? 'Hide build status' : 'Show build status';
});
